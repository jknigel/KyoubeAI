/**
 * User groups (docs/groups.md): protect the agents groups restrict, and give each person a
 * `tasks:assign` grant that covers what they may assign. The core facts this rests on are in
 * docs/superpowers/specs/2026-10-09-user-groups-design.md §4.
 */
import { canExtendPolicy, isProtected, managerIds, sameGrants, withoutProtection, withProtection, type AgentRow, type Grant, type Policy } from "./policy.js";

export interface AgentAccess { agentId: string; allowedUserIds: string[] }
/** A user member of the company, whatever their status (suspended and archived included). */
export interface MemberRow { userId: string; role: string | null; status: string }
/**
 * One person's `tasks:assign` row (null: no row) as KyoubeAI tracks it.
 * - `original`: the row before KyoubeAI changed it.
 * - `applied`: the last row KyoubeAI confirmed in the core. On a first change this
 *   starts as the row the core held (so equal to `original`); the type allows null for
 *   a person who held none.
 * - `pending`: a write KyoubeAI started but has not confirmed; absent when there is none.
 */
export interface PersonEntry { original: Grant | null; applied: Grant | null; pending?: Grant | null }
export interface GroupsRecord {
  /** Agents this feature set to protected (and so may unprotect). */
  protected: string[];
  /** Agents groups currently restrict. The manager rule never unprotects these. */
  required: string[];
  people: Record<string, PersonEntry>;
}
export const EMPTY_GROUPS_RECORD: GroupsRecord = { protected: [], required: [], people: {} };

/** A scope that matches no agent: an empty list would match every one (core's scopeValueList). */
export const NO_AGENT = "00000000-0000-4000-8000-000000000000";

export interface GroupsPort {
  listAgents(companyId: string): Promise<AgentRow[]>;
  listMembers(companyId: string): Promise<MemberRow[]>;
  getPolicy(companyId: string, agentId: string): Promise<Policy>;
  setPolicy(companyId: string, agentId: string, policy: Policy): Promise<void>;
  listUserGrants(companyId: string, userId: string): Promise<Grant[]>;
  setUserGrants(companyId: string, userId: string, grants: Grant[]): Promise<void>;
  readGroupsRecord(companyId: string): Promise<GroupsRecord>;
  writeGroupsRecord(companyId: string, record: GroupsRecord): Promise<void>;
}

export interface GroupsReport {
  protected: string[];
  unprotected: string[];
  people: string[];
  skipped: Array<{ id: string; reason: string }>;
  failures: Array<{ id: string; step: "policy" | "grants" | "record"; error: string }>;
}

const ASSIGN = "tasks:assign";
const sorted = (ids: Iterable<string>) => [...new Set(ids)].sort();
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isUnscoped = (grant: Grant) => grant.scope === null || Object.keys(grant.scope).length === 0;
const isManagerRole = (role: string | null) => role === "owner" || role === "admin";
const sameGrant = (a: Grant | null, b: Grant | null) => (a === null || b === null ? a === b : sameGrants([a], [b]));
const scopedTo = (ids: string[]): Grant => ({ permissionKey: ASSIGN, scope: { agentIds: ids.length > 0 ? sorted(ids) : [NO_AGENT] } });

/** The `tasks:assign` row a person should hold; "custom" when someone else scoped theirs. */
export function planPerson(input: { role: string | null; original: Grant | null; liveAgentIds: string[]; access: AgentAccess[]; userId: string }): Grant | null | "custom" {
  const live = new Set(input.liveAgentIds);
  const restricted = input.access.filter((entry) => live.has(entry.agentId));
  if (isManagerRole(input.role) || restricted.length === 0) return input.original;
  const allowed = restricted.filter((entry) => entry.allowedUserIds.includes(input.userId)).map((entry) => entry.agentId);
  if (input.original === null) return allowed.length > 0 ? scopedTo(allowed) : null;
  if (!isUnscoped(input.original)) return "custom";
  const forbidden = new Set(restricted.map((entry) => entry.agentId).filter((id) => !allowed.includes(id)));
  return scopedTo(input.liveAgentIds.filter((id) => !forbidden.has(id)));
}

export async function applyGroups(port: GroupsPort, companyId: string, access: AgentAccess[]): Promise<GroupsReport> {
  const report: GroupsReport = { protected: [], unprotected: [], people: [], skipped: [], failures: [] };
  const agents = await port.listAgents(companyId);
  const live = agents.filter((row) => row.status !== "terminated");
  const liveIds = live.map((row) => row.id);
  const managers = managerIds(agents);
  const required = sorted(access.map((entry) => entry.agentId).filter((id) => liveIds.includes(id)));
  let record = await port.readGroupsRecord(companyId);

  // Write-ahead, as in guard.ts: the record names a change before the change is made.
  const remember = async (id: string, next: GroupsRecord): Promise<boolean> => {
    if (JSON.stringify(next) === JSON.stringify(record)) return true;
    try { await port.writeGroupsRecord(companyId, next); record = next; return true; }
    catch (error) { report.failures.push({ id, step: "record", error: message(error) }); return false; }
  };

  if (!(await remember("required", { ...record, required }))) return report;

  for (const id of required) {
    try {
      const policy = await port.getPolicy(companyId, id);
      if (isProtected(policy)) continue; // someone else's protection: not ours to record or undo
      if (!canExtendPolicy(policy)) { report.skipped.push({ id, reason: "has an authorization policy KyoubeAI does not change" }); continue; }
      if (await remember(id, { ...record, protected: sorted([...record.protected, id]) })) {
        await port.setPolicy(companyId, id, withProtection(policy));
        report.protected.push(id);
      }
    } catch (error) { report.failures.push({ id, step: "policy", error: message(error) }); }
  }

  for (const id of record.protected) {
    if (required.includes(id) || managers.has(id)) continue;
    try {
      if (liveIds.includes(id)) {
        const policy = await port.getPolicy(companyId, id);
        if (isProtected(policy)) { await port.setPolicy(companyId, id, withoutProtection(policy)); report.unprotected.push(id); }
      }
      await remember(id, { ...record, protected: record.protected.filter((item) => item !== id) });
    } catch (error) { report.failures.push({ id, step: "policy", error: message(error) }); }
  }

  // Every user member, whatever their status: only a person who is gone from the list
  // entirely is forgotten. A suspended or archived member keeps their entry, so they are
  // still managed when they come back.
  const members = await port.listMembers(companyId);
  const memberIds = new Set(members.map((m) => m.userId));
  // Keeps the person's place in `people`, so an unchanged entry compares equal and is not rewritten.
  const withEntry = (id: string, entry: PersonEntry | null): GroupsRecord => {
    if (entry) return { ...record, people: { ...record.people, [id]: entry } };
    const { [id]: _gone, ...people } = record.people;
    return { ...record, people };
  };
  for (const id of Object.keys(record.people)) {
    // Gone from the company: the core refuses grants for non-members, and there is nothing to give back.
    if (!memberIds.has(id)) await remember(id, withEntry(id, null));
  }

  for (const member of members) {
    if (member.status !== "active") continue;
    const id = member.userId;
    try {
      const grants = await port.listUserGrants(companyId, id);
      const others = grants.filter((grant) => grant.permissionKey !== ASSIGN);
      const current = grants.find((grant) => grant.permissionKey === ASSIGN) ?? null;
      const stored = record.people[id];
      // The core's row is KyoubeAI's own when it is any row KyoubeAI held, wrote or started to
      // write for this person; an interrupted write (a crash, a lost reply, a failed record
      // write) always leaves one of these. Only a row matching none of them is a person's
      // change. Deliberately, a row a person sets by hand that equals `original` or `applied`
      // is read as KyoubeAI's and managed again (the accepted cost of surviving interruptions).
      if (stored && !(sameGrant(current, stored.applied) || sameGrant(current, stored.original) || (stored.pending !== undefined && sameGrant(current, stored.pending)))) {
        await remember(id, withEntry(id, null));
        report.skipped.push({ id, reason: "its assignment grant was changed by a person; KyoubeAI leaves it as they set it" });
        continue;
      }
      // What the core holds is now confirmed: it is the applied row, and any pending write is settled.
      const entry: PersonEntry | null = stored ? { original: stored.original, applied: current } : null;
      const original = entry ? entry.original : current;
      const desired = planPerson({ role: member.role, original, liveAgentIds: liveIds, access, userId: id });
      if (desired === "custom") { report.skipped.push({ id, reason: "has a custom assignment grant" }); continue; }
      const restoring = sameGrant(desired, original);
      if (sameGrant(desired, current)) {
        // Nothing to write: forget a finished restore, or record what an interrupted pass left.
        if (entry) await remember(id, withEntry(id, restoring ? null : entry));
        continue;
      }
      // Write-ahead: the row about to be written is pending until the core has taken it.
      if (!(await remember(id, withEntry(id, { original, applied: current, pending: desired })))) continue;
      try {
        await port.setUserGrants(companyId, id, desired ? [...others, desired] : others);
      } catch (error) {
        // The record keeps the pending write: whichever row the core holds now, the next
        // pass recognises it as KyoubeAI's and finishes the change.
        report.failures.push({ id, step: "grants", error: message(error) });
        continue;
      }
      await remember(id, withEntry(id, restoring ? null : { original, applied: desired }));
      report.people.push(id);
    } catch (error) { report.failures.push({ id, step: "grants", error: message(error) }); }
  }

  return report;
}

function isGrant(value: unknown): value is Grant {
  if (typeof value !== "object" || value === null) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.permissionKey === "string" && (raw.scope === null || (typeof raw.scope === "object" && !Array.isArray(raw.scope)));
}

/** The stored record, tolerating a missing or hand-edited value. */
export function parseGroupsRecord(value: unknown): GroupsRecord {
  if (typeof value !== "object" || value === null) return structuredClone(EMPTY_GROUPS_RECORD);
  const raw = value as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const people: Record<string, PersonEntry> = {};
  if (typeof raw.people === "object" && raw.people !== null) {
    for (const [id, entry] of Object.entries(raw.people as Record<string, unknown>)) {
      const e = entry as Record<string, unknown> | null;
      const row = (v: unknown) => v === null || isGrant(v);
      if (!e || !row(e.original) || !row(e.applied) || (e.pending !== undefined && !row(e.pending))) continue;
      people[id] = { original: e.original as Grant | null, applied: e.applied as Grant | null };
      if (e.pending !== undefined) people[id].pending = e.pending as Grant | null;
    }
  }
  return { protected: list(raw.protected), required: list(raw.required), people };
}

/** The route body's agent list; null when it is not one, so the caller can refuse it. */
export function parseAccess(value: unknown): AgentAccess[] | null {
  if (!Array.isArray(value)) return null;
  const out: AgentAccess[] = [];
  for (const item of value) {
    const raw = item as Record<string, unknown> | null;
    if (!raw || typeof raw.agentId !== "string" || !Array.isArray(raw.allowedUserIds) || !raw.allowedUserIds.every((u) => typeof u === "string")) return null;
    out.push({ agentId: raw.agentId, allowedUserIds: raw.allowedUserIds as string[] });
  }
  return out;
}
