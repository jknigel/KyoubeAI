/**
 * User groups (docs/groups.md): protect the agents groups restrict, and give each person a
 * `tasks:assign` grant that covers what they may assign. The core facts this rests on are in
 * docs/superpowers/specs/2026-10-09-user-groups-design.md §4.
 */
import { canExtendPolicy, isProtected, managerIds, sameGrants, withoutProtection, withProtection, type AgentRow, type Grant, type Policy } from "./policy.js";

export interface AgentAccess { agentId: string; allowedUserIds: string[] }
export interface MemberRow { userId: string; role: string | null }
/** One person's `tasks:assign` row before KyoubeAI changed it, and the row it wrote. */
export interface PersonEntry { original: Grant | null; applied: Grant }
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

  const members = await port.listMembers(companyId);
  const memberIds = new Set(members.map((m) => m.userId));
  for (const id of Object.keys(record.people)) {
    // Gone from the company: the core refuses grants for non-members, and there is nothing to give back.
    if (!memberIds.has(id)) { const { [id]: _gone, ...people } = record.people; await remember(id, { ...record, people }); }
  }

  for (const member of members) {
    const id = member.userId;
    try {
      const grants = await port.listUserGrants(companyId, id);
      const others = grants.filter((grant) => grant.permissionKey !== ASSIGN);
      const current = grants.find((grant) => grant.permissionKey === ASSIGN) ?? null;
      const entry = record.people[id];
      if (entry && !sameGrant(current, entry.applied)) {
        const { [id]: _changed, ...people } = record.people;
        await remember(id, { ...record, people });
        report.skipped.push({ id, reason: "its assignment grant was changed by a person; KyoubeAI leaves it as they set it" });
        continue;
      }
      const original = entry ? entry.original : current;
      const desired = planPerson({ role: member.role, original, liveAgentIds: liveIds, access, userId: id });
      if (desired === "custom") { report.skipped.push({ id, reason: "has a custom assignment grant" }); continue; }
      if (sameGrant(desired, current)) {
        if (entry && sameGrant(desired, original)) { const { [id]: _done, ...people } = record.people; await remember(id, { ...record, people }); }
        continue;
      }
      const restoring = sameGrant(desired, original);
      const next: GroupsRecord = restoring
        ? { ...record, people: Object.fromEntries(Object.entries(record.people).filter(([key]) => key !== id)) }
        : { ...record, people: { ...record.people, [id]: { original, applied: desired! } } };
      // Write-ahead for a new change; for a restore, the record is cleared only after the core took it.
      const before = record;
      if (!restoring && !(await remember(id, next))) continue;
      try {
        await port.setUserGrants(companyId, id, desired ? [...others, desired] : others);
      } catch (error) {
        // The core kept the old row: take the entry back too, or the next pass would read the
        // mismatch as a person's own change and stop managing this person.
        if (!restoring) await remember(id, before);
        throw error;
      }
      if (restoring) await remember(id, next);
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
      if (e && isGrant(e.applied) && (e.original === null || isGrant(e.original))) people[id] = { original: e.original as Grant | null, applied: e.applied };
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
