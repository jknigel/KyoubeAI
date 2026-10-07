import { CoreApiError, createCoreClient, createJsonRequest, type CompanySummary, type CoreClientOptions } from "../core-api.js";
import type { Governance } from "./governance.js";

export interface AgentRef {
  id: string;
  name: string;
  status: string;
}

/** `GET /api/agents/:id/instructions-bundle`, reduced to what decides whether KyoubeAI may edit the entry file. */
export interface InstructionsBundle {
  mode: string | null;
  entryFile: string;
  /** Whether the bundle's file list holds the entry file; a bundle without one is skipped, never created. */
  hasEntryFile: boolean;
  editable: boolean;
  legacyPromptTemplateActive: boolean;
}

/**
 * An instructions entry file as read, with the revision it was read at. Since core 2026.1005 a
 * write must name that revision (`baseRevisionId`; null for an entry with no revision yet), and
 * the core refuses it (409) when the file changed in between.
 */
export interface InstructionsFile {
  content: string;
  revisionId: string | null;
}

/** What `kyoube.agent-rules`'s reconcile route answers (plugins/kyoube-agent-rules/src/guard.ts), read defensively. */
export interface GuardReport {
  managers: string[];
  updated: string[];
  skipped: Array<{ agentId: string; name: string; reason: string }>;
  failures: Array<{ agentId: string; name: string; step: string; error: string }>;
  selfTest: { status: "pass" | "fail" | "not_applicable"; detail: string };
}

export interface GuardRevertReport {
  reverted: string[];
  failures: GuardReport["failures"];
}

export const GUARD_PLUGIN_ROUTES = {
  reconcile: "/api/plugins/kyoube.agent-rules/api/reconcile",
  revert: "/api/plugins/kyoube.agent-rules/api/revert",
} as const;

/** Everything `kyoube agent-rules` asks of the core, all through its REST API with the board key. */
export interface RulesApi {
  listCompanies(): Promise<CompanySummary[]>;
  listAgents(companyId: string): Promise<AgentRef[]>;
  getGovernance(companyId: string): Promise<Governance>;
  setGovernance(companyId: string, governance: Governance): Promise<void>;
  getInstructionsBundle(agentId: string): Promise<InstructionsBundle>;
  readInstructionsFile(agentId: string, path: string): Promise<InstructionsFile>;
  writeInstructionsFile(agentId: string, path: string, content: string, baseRevisionId: string | null): Promise<void>;
  reconcileGuard(companyId: string): Promise<GuardReport>;
  revertGuard(companyId: string): Promise<GuardRevertReport>;
  /**
   * False while the core answers the plugin's routes 503, right after a start before its worker
   * runs, or 404 `Plugin not found`, before `ensure-plugins` has installed it (the first start after an update).
   */
  pluginReady(): Promise<boolean>;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item) => typeof item === "object" && item !== null).map(record) : [];
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

function failures(value: unknown): GuardReport["failures"] {
  return records(value).map((item) => ({ agentId: text(item.agentId), name: text(item.name), step: text(item.step), error: text(item.error) }));
}

export function parseGuardReport(raw: unknown): GuardReport {
  const body = record(raw);
  const selfTest = record(body.selfTest);
  const status = selfTest.status === "pass" || selfTest.status === "fail" ? selfTest.status : "not_applicable";
  return {
    managers: strings(body.managers),
    updated: strings(body.updated),
    skipped: records(body.skipped).map((item) => ({ agentId: text(item.agentId), name: text(item.name), reason: text(item.reason) })),
    failures: failures(body.failures),
    selfTest: { status, detail: text(selfTest.detail) },
  };
}

export function parseRevertReport(raw: unknown): GuardRevertReport {
  const body = record(raw);
  return { reverted: strings(body.reverted), failures: failures(body.failures) };
}

export function createRulesApi(opts: CoreClientOptions): RulesApi {
  const core = createCoreClient(opts);
  const request = createJsonRequest(opts);
  const id = encodeURIComponent;
  return {
    listCompanies: () => core.listCompanies(),
    async listAgents(companyId) {
      return (await core.listAgents(companyId)).map(({ id: agentId, name, status }) => ({ id: agentId, name, status }));
    },
    async getGovernance(companyId) {
      const company = record(await request<unknown>(`/api/companies/${id(companyId)}`));
      if (typeof company.id !== "string") throw new Error(`the core returned no company for ${companyId}`);
      const governance = company.interactionResolverGovernance;
      if (governance !== null && governance !== undefined && typeof governance !== "object") {
        throw new Error(`the core returned an unreadable interactionResolverGovernance for ${companyId}`);
      }
      if (governance !== null && governance !== undefined && Array.isArray(governance)) {
        throw new Error(`the core returned an unreadable interactionResolverGovernance for ${companyId}`);
      }
      return governance === null || governance === undefined ? {} : (record(governance) as Governance);
    },
    async setGovernance(companyId, governance) {
      await request<unknown>(`/api/companies/${id(companyId)}`, { method: "PATCH", body: { interactionResolverGovernance: governance } });
    },
    async getInstructionsBundle(agentId) {
      const raw = record(await request<unknown>(`/api/agents/${id(agentId)}/instructions-bundle`));
      const entryFile = typeof raw.entryFile === "string" && raw.entryFile.length > 0 ? raw.entryFile : "AGENTS.md";
      return {
        mode: typeof raw.mode === "string" ? raw.mode : null,
        entryFile,
        hasEntryFile: records(raw.files).some((file) => file.path === entryFile),
        editable: raw.editable === true,
        legacyPromptTemplateActive: raw.legacyPromptTemplateActive === true,
      };
    },
    async readInstructionsFile(agentId, path) {
      const raw = record(await request<unknown>(`/api/agents/${id(agentId)}/instructions-bundle/file?path=${id(path)}`));
      // Never treat a missing body as an empty file: the next step would write
      // the block over whatever the agent's instructions really hold.
      if (typeof raw.content !== "string") throw new Error(`the core returned no content for ${path}`);
      const revisionId = record(raw.revision).id;
      return { content: raw.content, revisionId: typeof revisionId === "string" && revisionId.length > 0 ? revisionId : null };
    },
    async writeInstructionsFile(agentId, path, content, baseRevisionId) {
      await request<unknown>(`/api/agents/${id(agentId)}/instructions-bundle/file`, { method: "PUT", body: { path, content, baseRevisionId } });
    },
    async reconcileGuard(companyId) {
      return parseGuardReport(await request<unknown>(GUARD_PLUGIN_ROUTES.reconcile, { method: "POST", body: { companyId } }));
    },
    async revertGuard(companyId) {
      return parseRevertReport(await request<unknown>(GUARD_PLUGIN_ROUTES.revert, { method: "POST", body: { companyId } }));
    },
    async pluginReady() {
      // The route takes POST only. The core checks the plugin's status and
      // worker before it matches a route, so a GET answers 503 until the worker
      // runs and 404 after, and never reaches the worker. A plugin not installed
      // yet answers 404 `Plugin not found`. Anything else is left for the pass
      // to report.
      try {
        await request<unknown>(GUARD_PLUGIN_ROUTES.reconcile);
        return true;
      } catch (error) {
        if (!(error instanceof CoreApiError)) return true;
        return !(error.status === 503 || (error.status === 404 && error.message === "Plugin not found"));
      }
    },
  };
}
