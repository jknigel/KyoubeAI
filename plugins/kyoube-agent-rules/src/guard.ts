import {
  canExtendPolicy, desiredGrants, isBroadAssign, isOwnTeamGrant, isProtected, managerIds, sameGrants, withoutProtection, withProtection,
  type AgentRow, type Grant, type Policy,
} from "./policy.js";

/** What the guardrail needs from the host; `plugin.ts` adapts `ctx` to it and the tests fake it. */
export interface GuardPort {
  listAgents(companyId: string): Promise<AgentRow[]>;
  getPolicy(companyId: string, agentId: string): Promise<Policy>;
  setPolicy(companyId: string, agentId: string, policy: Policy): Promise<void>;
  listGrants(companyId: string, agentId: string): Promise<Grant[]>;
  setGrants(companyId: string, agentId: string, grants: Grant[]): Promise<void>;
  previewAssign(companyId: string, actorAgentId: string, assigneeAgentId: string): Promise<{ allowed: boolean; reason: string }>;
  readRecord(companyId: string): Promise<GuardRecord>;
  writeRecord(companyId: string, record: GuardRecord): Promise<void>;
}

/** What the guardrail changed in one company, so revert undoes exactly that and nothing someone else set. */
export interface GuardRecord {
  /** Agents whose assignment policy the guardrail set to protected. */
  protected: string[];
  /** Agents the guardrail gave an own-team grant. */
  scoped: string[];
  /** Agents the guardrail took the broad assign grant from. */
  broadRemoved: string[];
}

export const EMPTY_RECORD: GuardRecord = { protected: [], scoped: [], broadRemoved: [] };

export interface AgentNote { agentId: string; name: string; reason: string }
export interface AgentFailure { agentId: string; name: string; step: "policy" | "grants" | "record"; error: string }
export interface SelfTest { status: "pass" | "fail" | "not_applicable"; detail: string }

export interface GuardReport {
  managers: string[];
  updated: string[];
  skipped: AgentNote[];
  failures: AgentFailure[];
  selfTest: SelfTest;
}

export interface RevertReport {
  reverted: string[];
  failures: AgentFailure[];
}

/** Statuses the self-test picks agents from: core runs a plain assignment check for these. */
const SELF_TEST_STATUSES = new Set(["active", "idle", "running"]);

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sortedUnique(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

function sameRecord(a: GuardRecord, b: GuardRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function drop(record: GuardRecord, id: string): GuardRecord {
  return {
    protected: record.protected.filter((item) => item !== id),
    scoped: record.scoped.filter((item) => item !== id),
    broadRemoved: record.broadRemoved.filter((item) => item !== id),
  };
}

/** One company: protect its managers, give each its own-team grant, and take the broad assign grant from every agent. */
export async function reconcileGuard(port: GuardPort, companyId: string): Promise<GuardReport> {
  const agents = await port.listAgents(companyId);
  const managers = managerIds(agents);
  let record = await port.readRecord(companyId);
  const report: GuardReport = { managers: sortedUnique(managers), updated: [], skipped: [], failures: [], selfTest: { status: "not_applicable", detail: "" } };

  // Write-ahead: the record names an agent before the change is made, so a
  // change can never land unrecorded. Reverting an agent whose change then
  // failed is a no-op.
  const remember = async (agent: AgentRow, next: GuardRecord): Promise<boolean> => {
    if (sameRecord(record, next)) return true;
    try {
      await port.writeRecord(companyId, next);
      record = next;
      return true;
    } catch (error) {
      report.failures.push({ agentId: agent.id, name: agent.name, step: "record", error: message(error) });
      return false;
    }
  };

  for (const agent of agents) {
    if (agent.status === "terminated") continue;
    if (agent.status === "pending_approval") {
      report.skipped.push({ agentId: agent.id, name: agent.name, reason: "waiting for approval; core freezes its permissions until then" });
      continue;
    }
    const isManager = managers.has(agent.id);
    let wrote = false;

    try {
      const policy = await port.getPolicy(companyId, agent.id);
      if (isManager && !isProtected(policy)) {
        if (!canExtendPolicy(policy)) {
          report.skipped.push({ agentId: agent.id, name: agent.name, reason: "has an authorization policy KyoubeAI does not change" });
        } else if (await remember(agent, { ...record, protected: sortedUnique([...record.protected, agent.id]) })) {
          await port.setPolicy(companyId, agent.id, withProtection(policy));
          wrote = true;
        }
      } else if (!isManager && record.protected.includes(agent.id)) {
        if (isProtected(policy)) {
          await port.setPolicy(companyId, agent.id, withoutProtection(policy));
          wrote = true;
        }
        await remember(agent, { ...record, protected: record.protected.filter((id) => id !== agent.id) });
      }
    } catch (error) {
      report.failures.push({ agentId: agent.id, name: agent.name, step: "policy", error: message(error) });
    }

    try {
      const grants = await port.listGrants(companyId, agent.id);
      const next = isManager ? desiredGrants(grants, agent.id, true) : desiredGrants(grants, agent.id, false).concat(grants.filter((grant) => !record.scoped.includes(agent.id) && isOwnTeamGrant(grant, agent.id)));
      let applied = true;
      if (!sameGrants(grants, next)) {
        const planned: GuardRecord = {
          ...record,
          scoped: isManager && !grants.some((grant) => isOwnTeamGrant(grant, agent.id)) ? sortedUnique([...record.scoped, agent.id]) : record.scoped,
          broadRemoved: grants.some(isBroadAssign) ? sortedUnique([...record.broadRemoved, agent.id]) : record.broadRemoved,
        };
        applied = await remember(agent, planned);
        if (applied) {
          await port.setGrants(companyId, agent.id, next);
          wrote = true;
        }
      }
      if (applied && !isManager && record.scoped.includes(agent.id)) {
        await remember(agent, { ...record, scoped: record.scoped.filter((id) => id !== agent.id) });
      }
    } catch (error) {
      report.failures.push({ agentId: agent.id, name: agent.name, step: "grants", error: message(error) });
    }

    if (wrote) report.updated.push(agent.id);
  }

  const excluded = new Set([...report.skipped.map((note) => note.agentId), ...report.failures.map((failure) => failure.agentId)]);
  report.selfTest = await selfTest(port, companyId, agents, excluded);
  return report;
}

/**
 * Asks the core's own assignment check whether the guardrail holds on the core
 * that is running: a report may not assign to its manager, and the manager may
 * still assign to the report. Skips manager ids in the excluded set (e.g., managers
 * the guardrail explicitly skipped).
 */
export async function selfTest(port: GuardPort, companyId: string, agents: AgentRow[], excluded: ReadonlySet<string> = new Set()): Promise<SelfTest> {
  const byId = new Map(agents.map((row) => [row.id, row]));
  const pair = [...agents]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((report) => ({ report, manager: report.reportsTo ? byId.get(report.reportsTo) : undefined }))
    .find(({ report, manager }) => manager !== undefined && !excluded.has(manager.id) && SELF_TEST_STATUSES.has(report.status) && SELF_TEST_STATUSES.has(manager.status));
  const report = pair?.report;
  const manager = pair?.manager;
  if (!report || !manager) return { status: "not_applicable", detail: "no active manager with an active direct report" };
  try {
    const up = await port.previewAssign(companyId, report.id, manager.id);
    const down = await port.previewAssign(companyId, manager.id, report.id);
    if (!up.allowed && down.allowed) {
      return { status: "pass", detail: `${report.name} cannot assign to ${manager.name}; ${manager.name} can assign to ${report.name}` };
    }
    const problems: string[] = [];
    if (up.allowed) problems.push(`${report.name} can still assign to its manager ${manager.name} (${up.reason})`);
    if (!down.allowed) problems.push(`${manager.name} cannot assign to its report ${report.name} (${down.reason})`);
    return { status: "fail", detail: problems.join("; ") };
  } catch (error) {
    return { status: "fail", detail: `core's assignment preview failed: ${message(error)}` };
  }
}

/** Undoes what the record says this guardrail changed in one company, and nothing else. */
export async function revertGuard(port: GuardPort, companyId: string): Promise<RevertReport> {
  const record = await port.readRecord(companyId);
  const agents = new Map((await port.listAgents(companyId)).map((row) => [row.id, row]));
  const report: RevertReport = { reverted: [], failures: [] };
  let remaining: GuardRecord = { ...record };

  for (const id of sortedUnique([...record.protected, ...record.scoped, ...record.broadRemoved])) {
    const agent = agents.get(id);
    if (!agent) {
      // Deleted since: there is nothing left to give back.
      remaining = drop(remaining, id);
      continue;
    }
    try {
      if (record.protected.includes(id)) {
        const policy = await port.getPolicy(companyId, id);
        if (isProtected(policy)) await port.setPolicy(companyId, id, withoutProtection(policy));
      }
    } catch (error) {
      report.failures.push({ agentId: id, name: agent.name, step: "policy", error: message(error) });
      continue;
    }
    try {
      const grants = await port.listGrants(companyId, id);
      let next = record.scoped.includes(id) ? grants.filter((grant) => !isOwnTeamGrant(grant, id)) : grants;
      if (record.broadRemoved.includes(id) && !next.some(isBroadAssign)) next = [...next, { permissionKey: "tasks:assign", scope: null }];
      if (!sameGrants(grants, next)) await port.setGrants(companyId, id, next);
    } catch (error) {
      report.failures.push({ agentId: id, name: agent.name, step: "grants", error: message(error) });
      continue;
    }
    remaining = drop(remaining, id);
    report.reverted.push(id);
  }

  await port.writeRecord(companyId, remaining);
  return report;
}
