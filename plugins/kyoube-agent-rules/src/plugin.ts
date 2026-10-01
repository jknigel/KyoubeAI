import { definePlugin, type PaperclipPlugin, type PluginContext } from "@paperclipai/plugin-sdk";
import { EMPTY_RECORD, reconcileGuard, revertGuard, type GuardPort, type GuardRecord } from "./guard.js";
import { PLUGIN_ID } from "./manifest.js";
import type { Grant } from "./policy.js";

type HostGrant = Parameters<PluginContext["authorization"]["grants"]["set"]>[0]["grants"][number];

/** Plugin state key of the per-company record of what the guardrail changed. */
const RECORD_KEY = "guard-record";

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

/** The stored record, tolerating a missing or hand-edited value. */
export function parseRecord(value: unknown): GuardRecord {
  if (typeof value !== "object" || value === null) return { ...EMPTY_RECORD };
  const raw = value as Record<string, unknown>;
  return { protected: ids(raw.protected), scoped: ids(raw.scoped), broadRemoved: ids(raw.broadRemoved) };
}

/** The guardrail's view of the host, built only from the plugin SDK. */
export function portFromContext(ctx: PluginContext): GuardPort {
  const scope = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, stateKey: RECORD_KEY });
  return {
    async listAgents(companyId) {
      const rows = await ctx.agents.list({ companyId });
      return rows.map((agent) => ({ id: agent.id, name: agent.name, status: agent.status, reportsTo: agent.reportsTo ?? null }));
    },
    async getPolicy(companyId, agentId) {
      const record = await ctx.authorization.policies.get({ companyId, resourceType: "agent", resourceId: agentId });
      return record?.policy ?? null;
    },
    async setPolicy(companyId, agentId, policy) {
      await ctx.authorization.policies.update({ companyId, resourceType: "agent", resourceId: agentId, policy });
    },
    async listGrants(companyId, agentId) {
      const rows = await ctx.authorization.grants.list({ companyId, principalType: "agent", principalId: agentId });
      return rows.map((grant) => ({ permissionKey: grant.permissionKey, scope: grant.scope ?? null }));
    },
    async setGrants(companyId, agentId, grants: Grant[]) {
      await ctx.authorization.grants.set({
        companyId,
        principalType: "agent",
        principalId: agentId,
        grants: grants.map((grant) => ({ permissionKey: grant.permissionKey as HostGrant["permissionKey"], scope: grant.scope })),
      });
    },
    async previewAssign(companyId, actorAgentId, assigneeAgentId) {
      const decision = await ctx.authorization.policies.previewAssignment({
        companyId,
        actor: { type: "agent", agentId: actorAgentId, companyId },
        target: { assigneeAgentId },
      });
      return { allowed: decision.allowed, reason: decision.reason };
    },
    async readRecord(companyId) {
      return parseRecord(await ctx.state.get(scope(companyId)));
    },
    async writeRecord(companyId, record) {
      await ctx.state.set(scope(companyId), record);
    },
  };
}

export interface AgentRulesPluginDeps {
  /** Tests swap the host adapter for a fake; production adapts `ctx`. */
  port?: (ctx: PluginContext) => GuardPort;
}

export function createAgentRulesPlugin(deps: AgentRulesPluginDeps = {}): PaperclipPlugin {
  // `onApiRequest` runs outside `setup`, so the port and logger live in this
  // instance's closure, never in a module-level singleton two instances in
  // one process would share.
  let port: GuardPort | null = null;
  let logError: ((message: string, meta?: Record<string, unknown>) => void) | null = null;
  // Serialized per company, so a reconcile and a revert never interleave their reads and writes of the record.
  const lastCall = new Map<string, Promise<unknown>>();
  const serialized = <T>(companyId: string, run: () => Promise<T>): Promise<T> => {
    const result = (lastCall.get(companyId) ?? Promise.resolve()).then(run);
    // A failed call must not break the chain for the next one; its own caller still sees the error.
    lastCall.set(companyId, result.catch(() => undefined));
    return result;
  };

  return definePlugin({
    async setup(ctx: PluginContext) {
      port = (deps.port ?? portFromContext)(ctx);
      logError = (message, meta) => ctx.logger.error(message, meta);
      ctx.logger.info(`${PLUGIN_ID} worker ready`);
    },

    async onApiRequest(input) {
      const guard = port;
      if (!guard) return { status: 503, body: { error: "plugin not ready" } };
      // Declared `auth: "board"`, which the host enforces before the request
      // reaches this worker; checked again so a mis-declared route could never
      // let an agent loosen its own guardrail.
      if (input.actor.actorType === "agent") return { status: 403, body: { error: "forbidden: board access required", code: "forbidden" } };
      try {
        if (input.routeKey === "guard.reconcile") return { status: 200, body: await serialized(input.companyId, () => reconcileGuard(guard, input.companyId)) };
        if (input.routeKey === "guard.revert") return { status: 200, body: await serialized(input.companyId, () => revertGuard(guard, input.companyId)) };
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        logError?.(`${input.routeKey} failed`, { companyId: input.companyId, error: text });
        // Board-only: the caller is the operator's own `kyoube` CLI, which
        // shows this reason in `kyoube doctor`.
        return { status: 500, body: { error: `${input.routeKey} failed: ${text}`, code: "error" } };
      }
      return { status: 404, body: { error: `unknown route ${input.routeKey}` } };
    },

    async onHealth() {
      return port ? { status: "ok", message: `${PLUGIN_ID} ready` } : { status: "degraded", message: `${PLUGIN_ID} not ready` };
    },
  });
}
