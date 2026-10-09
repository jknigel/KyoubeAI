import { CoreApiError, type CompanySummary } from "../core-api.js";
import type { AgentRef, RulesApi } from "./api.js";
import { applyRules, removeRules } from "./block.js";
import { planGovernance, revertGovernance } from "./governance.js";
import type { CompanyReport, Failure, PassReport } from "./report.js";
import type { AgentRulesState } from "./state.js";

export interface PassDeps {
  api: RulesApi;
  now: () => Date;
}

/**
 * A failure as `kyoube doctor` should show it. A 404, 405 or 422 on a route
 * this feature depends on is the sign that a core update moved something,
 * so the message names that route.
 */
export function describeError(error: unknown): string {
  if (error instanceof CoreApiError && error.route) {
    if (error.status === 404 && error.route.includes("/api/plugins/kyoube.agent-rules/")) {
      return `the kyoube.agent-rules plugin is not installed or not ready (${error.route} → 404): ${error.message}`;
    }
    if ([404, 405, 422].includes(error.status)) return `the core no longer accepts ${error.route} (${error.status}): ${error.message}`;
    return `${error.route} failed (${error.status}): ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function companyReport(company: CompanySummary): CompanyReport {
  return { companyId: company.id, name: company.name || company.id, governance: "already", guard: null, groups: null, rulesUpdated: [], skipped: [], failures: [], writes: 0 };
}

async function listCompanies(deps: PassDeps, report: PassReport): Promise<CompanySummary[] | null> {
  try {
    return await deps.api.listCompanies();
  } catch (error) {
    report.failures.push({ step: "list", error: describeError(error) });
    return null;
  }
}

/** Edits one agent's entry file with `edit`, only when the core says KyoubeAI may. */
async function editAgent(api: RulesApi, agent: AgentRef, entry: CompanyReport, edit: typeof applyRules): Promise<void> {
  try {
    const bundle = await api.getInstructionsBundle(agent.id);
    if (bundle.mode !== "managed" || !bundle.editable) {
      entry.skipped.push({ agent: agent.name, reason: `its instructions are not a managed bundle KyoubeAI can edit (mode ${bundle.mode ?? "none"})` });
      return;
    }
    if (bundle.legacyPromptTemplateActive) {
      entry.skipped.push({ agent: agent.name, reason: "it still uses the legacy prompt template" });
      return;
    }
    if (!bundle.hasEntryFile) {
      entry.skipped.push({ agent: agent.name, reason: `its instructions bundle has no ${bundle.entryFile}` });
      return;
    }
    const file = await api.readInstructionsFile(agent.id, bundle.entryFile);
    const result = edit(file.content);
    if (result.kind === "corrupt") {
      entry.skipped.push({ agent: agent.name, reason: `${bundle.entryFile}: ${result.reason}` });
      return;
    }
    if (result.kind === "changed") {
      // Written on the revision just read: if someone saved the file in between, the core
      // refuses (409) and this agent is retried on the next pass, so their edit is never lost.
      await api.writeInstructionsFile(agent.id, bundle.entryFile, result.content, file.revisionId);
      entry.rulesUpdated.push(agent.name);
      entry.writes += 1;
    }
  } catch (error) {
    entry.failures.push({ step: "rules", agent: agent.name, error: describeError(error) });
  }
}

async function editAgents(api: RulesApi, companyId: string, entry: CompanyReport, edit: typeof applyRules): Promise<void> {
  let agents: AgentRef[];
  try {
    agents = await api.listAgents(companyId);
  } catch (error) {
    entry.failures.push({ step: "rules", error: describeError(error) });
    return;
  }
  for (const agent of agents) {
    // The core freezes the config of an agent waiting for approval, and an instructions write
    // updates its adapterConfig. No skipped entry: the plugin's report lists it as waiting.
    if (agent.status === "terminated" || agent.status === "pending_approval") continue;
    await editAgent(api, agent, entry, edit);
  }
}

/**
 * Groups (docs/groups.md): read who may assign which agent from kyoube.apps, have kyoube.agent-rules
 * apply it, and tell kyoube.apps how it went. A failed read skips the step: an unreadable list must
 * never be applied as "no groups", which would lift every restriction.
 */
async function groupsStep(deps: PassDeps, companyId: string, entry: CompanyReport): Promise<void> {
  const syncedAt = deps.now().toISOString();
  let error: string | null = null;
  try {
    const access = await deps.api.getAgentAccess(companyId);
    const groups = await deps.api.applyGroups(companyId, access);
    entry.groups = groups;
    entry.writes += groups.protected.length + groups.unprotected.length + groups.people.length;
    for (const skipped of groups.skipped) entry.skipped.push({ agent: skipped.id, reason: skipped.reason });
    for (const failure of groups.failures) entry.failures.push({ step: "groups", agent: failure.id, error: `${failure.step}: ${failure.error}` });
    if (groups.failures.length > 0) error = `${groups.failures.length} failure(s); see kyoube doctor`;
  } catch (caught) {
    error = describeError(caught);
    entry.failures.push({ step: "groups", error });
  }
  try {
    await deps.api.reportGroupSync(companyId, { syncedAt, error });
  } catch (caught) {
    entry.failures.push({ step: "groups", error: `could not report the sync: ${describeError(caught)}` });
  }
}

/** One pass: in every company, G1, then G2 through the plugin, then the rules block. Each step and each agent fails on its own. */
export async function applyPass(deps: PassDeps, state: AgentRulesState): Promise<{ report: PassReport; state: AgentRulesState }> {
  const report: PassReport = { at: deps.now().toISOString(), mode: "apply", companies: [], failures: [] };
  const governancePrevious = { ...state.governancePrevious };
  const companies = (await listCompanies(deps, report)) ?? [];

  for (const company of companies) {
    const entry = companyReport(company);
    try {
      const plan = planGovernance(await deps.api.getGovernance(company.id));
      // Record governance even when unchanged, to preserve pre-existing people-only settings.
      // The first recorded value wins: a later pass must not record KyoubeAI's own entry as
      // "what was there before".
      governancePrevious[company.id] = { ...plan.previous, ...(governancePrevious[company.id] ?? {}) };
      if (plan.changed) {
        await deps.api.setGovernance(company.id, plan.next);
        entry.governance = "set";
        entry.writes += 1;
      }
    } catch (error) {
      entry.governance = "failed";
      entry.failures.push({ step: "governance", error: describeError(error) });
    }

    try {
      const guard = await deps.api.reconcileGuard(company.id);
      entry.guard = guard;
      entry.writes += guard.updated.length;
      for (const skipped of guard.skipped) entry.skipped.push({ agent: skipped.name, reason: skipped.reason });
      for (const failure of guard.failures) entry.failures.push({ step: "guard", agent: failure.name, error: `${failure.step}: ${failure.error}` });
      if (guard.selfTest.status === "fail") entry.failures.push({ step: "guard", error: `self-test failed: ${guard.selfTest.detail}` });
    } catch (error) {
      entry.failures.push({ step: "guard", error: describeError(error) });
    }

    await groupsStep(deps, company.id, entry);
    await editAgents(deps.api, company.id, entry, applyRules);
    report.companies.push(entry);
  }

  return { report, state: { ...state, governancePrevious, lastPass: report } };
}

/** `kyoube agent-rules off`: G1 back as it was, G2 undone by the plugin, the blocks removed. */
export async function revertPass(deps: PassDeps, state: AgentRulesState): Promise<{ report: PassReport; state: AgentRulesState }> {
  const report: PassReport = { at: deps.now().toISOString(), mode: "revert", companies: [], failures: [] };
  const governancePrevious = { ...state.governancePrevious };
  const companies = (await listCompanies(deps, report)) ?? [];

  for (const company of companies) {
    const entry = companyReport(company);
    try {
      const { next, changed } = revertGovernance(await deps.api.getGovernance(company.id), governancePrevious[company.id]);
      if (changed) {
        await deps.api.setGovernance(company.id, next);
        entry.governance = "restored";
        entry.writes += 1;
      }
      delete governancePrevious[company.id];
    } catch (error) {
      entry.governance = "failed";
      entry.failures.push({ step: "governance", error: describeError(error) });
    }

    try {
      const reverted = await deps.api.revertGuard(company.id);
      entry.writes += reverted.reverted.length;
      for (const failure of reverted.failures) entry.failures.push({ step: "guard", agent: failure.name, error: `${failure.step}: ${failure.error}` });
    } catch (error) {
      entry.failures.push({ step: "guard", error: describeError(error) });
    }

    await editAgents(deps.api, company.id, entry, removeRules);
    report.companies.push(entry);
  }

  return { report, state: { ...state, governancePrevious, lastPass: report } };
}
