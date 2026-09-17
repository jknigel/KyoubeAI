import { definePlugin, type PaperclipPlugin, type PluginContext, type PluginLogger } from "@paperclipai/plugin-sdk";
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk/protocol";
import type { Pool } from "pg";
import { handleApiRequest } from "./api-routes.js";
import { handleAppsApiRequest } from "./apps/api-routes.js";
import { MAX_APP_NOTES } from "./apps/manifest.js";
import { AppService, parseRuntimeMethod, type AppServiceDeps } from "./apps/service.js";
import { registerAppTools } from "./apps/tools.js";
import { DataError } from "./data/errors.js";
import { parseLevel, type DataActor } from "./data/permissions.js";
import { DataService, type DataServiceDeps, type MutationEvent } from "./data/service.js";
import { runMetaMigrations } from "./db/migrate.js";
import { createPool as defaultCreatePool } from "./db/pool.js";
import type { KyoubeRuntimeConfig } from "./kyoube-config.js";
import { APPS_SKILL_KEY, DATA_SKILL_KEY, PLUGIN_ID, PURGE_JOB_KEY } from "./manifest.js";
import { RoleResolver } from "./roles.js";
import { registerTools } from "./tools.js";

export interface AppsPluginDeps {
  loadKyoubeConfig: () => Promise<KyoubeRuntimeConfig>;
  migrationsDir: string;
  createPool?: (url: string) => Pool;
  migrate?: (pool: Pool, dir: string) => Promise<unknown>;
  createService?: (deps: DataServiceDeps) => DataService;
  createAppService?: (deps: AppServiceDeps) => AppService;
}

type Params = Record<string, unknown>;

/**
 * Invariant (Ruling P2-R23): the actor is narrowed to "user" | "agent" from
 * the host-authenticated `context.actor` ONLY — never from `params` — and must
 * never produce `{ kind: "system" }` (see `systemActor()` in data/service.ts),
 * which grants unconditional schema access and is plugin-internal only.
 */
export function actorFromAction(context: PluginPerformActionContext): DataActor {
  const actor = context.actor;
  if (actor.type === "user" && actor.userId) return { kind: "user", id: actor.userId, runId: null };
  if (actor.type === "agent" && actor.agentId) return { kind: "agent", id: actor.agentId, runId: actor.runId ?? null };
  throw new DataError("forbidden", "data actions require a signed-in user or an agent run");
}

function str(params: Params, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) throw new DataError("invalid", `${key} is required`);
  return value;
}

/** The version union `AppService.get` takes; the merged runner asks for `"latest"`. */
function versionRef(params: Params): number | "current" | "latest" {
  const value = params.version;
  if (value === undefined || value === null) return "latest";
  if (value === "current" || value === "latest") return value;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  throw new DataError("invalid", "version must be an integer, current, or latest");
}

/** A numbered version, as a rollback requires. */
function versionNumber(params: Params): number {
  const value = params.version;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new DataError("invalid", "version must be an integer");
  return value;
}

/** The same, but absent means "the latest version", as a publish allows. */
function optionalVersionNumber(params: Params): number | undefined {
  return params.version === undefined || params.version === null ? undefined : versionNumber(params);
}

/**
 * The note recorded with a new app version. Absent and null both mean "no
 * note"; anything else is checked rather than cast, so a number (or an object)
 * from a bridge caller is refused here instead of reaching the store as a
 * would-be string — the same rule the `apps_create`/`apps_update` tool schemas
 * and the REST body schema apply.
 */
function optionalNotes(params: Params): string | null {
  const value = params.notes;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new DataError("invalid", "notes must be a string");
  if (value.length > MAX_APP_NOTES) throw new DataError("invalid", `notes must be at most ${MAX_APP_NOTES} characters`);
  return value;
}

/**
 * Ruling P2-R6: the host's company scope wins. A caller-supplied `companyId` is
 * only a fallback for a bridge call the host did not scope; when the host did
 * scope the call, a different `params.companyId` is a spoofing attempt, not a
 * fallback, and is rejected outright.
 */
function companyOf(context: PluginPerformActionContext, params: Params): string {
  const claimed = typeof params.companyId === "string" && params.companyId.length > 0 ? params.companyId : null;
  if (context.companyId && claimed && claimed !== context.companyId) {
    throw new DataError("invalid", "companyId does not match the authorised company");
  }
  const companyId = context.companyId ?? claimed;
  if (!companyId) throw new DataError("invalid", "companyId is required");
  return companyId;
}

export function createAppsPlugin(deps: AppsPluginDeps): PaperclipPlugin {
  // Ruling P2-R5: `onApiRequest`, `onHealth` and `onShutdown` run outside
  // `setup`, so the pool, the service and the logger live in this plugin
  // instance's closure — never in a module-level singleton, which two plugin
  // instances in one process would share.
  let pool: Pool | null = null;
  let service: DataService | null = null;
  // Ruling P3-R8: the AppService lives beside the data service in this
  // closure — never in a module-level `currentApps`, which two plugin
  // instances in one process would share.
  let apps: AppService | null = null;
  let logger: PluginLogger | null = null;
  // The skill import the `skills.install` route runs; lives here for the same
  // reason the services do (`onApiRequest` runs outside `setup`).
  let installSkillsForCompany: ((companyId: string) => Promise<unknown>) | null = null;

  return definePlugin({
    async setup(ctx: PluginContext) {
      const config = await deps.loadKyoubeConfig();
      const dbPool = (deps.createPool ?? defaultCreatePool)(config.dataDatabaseUrl);
      pool = dbPool;
      logger = ctx.logger;
      await (deps.migrate ?? runMetaMigrations)(dbPool, deps.migrationsDir);
      const roles = new RoleResolver(ctx.access.members);
      /**
       * One summariser for both services, parameterised per service: a single line per mutation,
       * carrying counts and identifiers only — never row values, a manifest, or an app's source.
       *
       * `name` and `entityType` are what differ. A table changing and an app being published are
       * not the same kind of event and must not be filed as one: the feed is read (and filtered)
       * by entity, so a lifecycle row that claimed `kyoube_table` with no table would point at
       * nothing at all. `entityId` is what the event is *about* — the app's id for a lifecycle
       * change; for a data mutation the service names no entity of its own, so the mutated table
       * stands in, exactly as it always has.
       */
      const summariser = (name: "data" | "apps", entityType: string) => ({
        log: async (event: MutationEvent) => {
          await ctx.activity.log({
            companyId: event.companyId,
            message: `Kyoube ${name}: ${event.summary}`,
            entityType,
            entityId: event.entityId ?? event.table ?? undefined,
            metadata: { operation: event.operation, actorKind: event.actor.kind, actorId: event.actor.id, runId: event.actor.runId ?? null },
          });
        },
        // Ruling P2-R23: the mutation already committed, so a failed activity
        // log must not fail the write — it is reported here instead of thrown.
        onError: (error: unknown, event: MutationEvent) =>
          ctx.logger.warn(`${name} activity log failed`, { companyId: event.companyId, operation: event.operation, error: String(error) }),
      });
      const dataActivity = summariser("data", "kyoube_table");
      const appsActivity = summariser("apps", "kyoube_app");
      const dataService = (deps.createService ?? ((serviceDeps) => new DataService(serviceDeps)))({
        pool: dbPool,
        // Ruling P4-R13: a schema, grant or settings change asks the host again; everything else
        // takes the 30 s cache.
        resolveUserRole: (companyId, userId, fresh) => (fresh ? roles.resolveFresh(companyId, userId) : roles.resolveRole(companyId, userId)),
        onMutation: dataActivity.log,
        onMutationError: dataActivity.onError,
      });
      service = dataService;
      // The apps service resolves every caller's level through this same
      // DataService, so an app can only ever narrow its viewer's access.
      const appService = (deps.createAppService ?? ((appDeps) => new AppService(appDeps)))({
        pool: dbPool,
        data: dataService,
        onMutation: appsActivity.log,
        onMutationError: appsActivity.onError,
      });
      apps = appService;

      registerTools(ctx, dataService);
      registerAppTools(ctx, appService);

      // ---- UI reads (company scope is host-authorised; reads need only member access) ----
      // Ruling P2-R10, as corrected by P2-R29: `params.userId` here is
      // client-supplied, not host-authenticated. Upstream's `bridge/data` route
      // passes `body.params` straight through and merges only `companyId` into
      // it (verified against 2026.831.1 `server/src/routes/plugins.ts`; the SDK's
      // `handleGetData` merges only `companyId` and `renderEnvironment`) — unlike
      // the action path, which derives a trusted actor from the signed-in user.
      // Reads are safe regardless: the host's `assertCompanyAccess` gates company
      // membership before a read reaches this worker, and every read bridge needs
      // no more than `read`, which every member holds. The level this actor
      // resolves to is therefore advisory — `data.access` reports what the named
      // user may do, it does not authorise the caller — so never expose anything
      // above `read` through a data read. Every mutation and schema change takes
      // its actor from the host-authenticated action context (`actorFromAction`).
      const readActor = (params: Params): DataActor => ({ kind: "user", id: typeof params.userId === "string" ? params.userId : null, runId: null });
      ctx.data.register("data.tables", async (params) => dataService.listTables(str(params, "companyId"), readActor(params)));
      ctx.data.register("data.table", async (params) => dataService.describeTable(str(params, "companyId"), readActor(params), str(params, "table")));
      ctx.data.register("data.rows", async (params) => dataService.query(str(params, "companyId"), readActor(params), str(params, "table"), {
        where: params.where, orderBy: params.orderBy as never, limit: params.limit as number | undefined, offset: params.offset as number | undefined,
      }));
      ctx.data.register("data.count", async (params) => ({ count: await dataService.count(str(params, "companyId"), readActor(params), str(params, "table"), params.where) }));
      ctx.data.register("data.access", async (params) => {
        const companyId = str(params, "companyId");
        const access = await dataService.myAccess(companyId, readActor(params));
        // The sidebar asks this for every company a person opens, and the host
        // scopes the read to that company — the first such visit is also the
        // first chance to put the Kyoube skills into a company that predates the
        // worker (see `ensureSkillsOnce`). Awaited, not fired and forgotten: the
        // host only lets the reconcile through while this invocation is open.
        await ensureSkillsOnce(companyId);
        return access;
      });

      // ---- UI actions (actor supplied by the host) ----
      const action = (key: string, fn: (companyId: string, actor: DataActor, params: Params) => Promise<unknown>) =>
        ctx.actions.register(key, async (params, context) => fn(companyOf(context, params), actorFromAction(context), params));

      action("data.create_table", (c, a, p) => dataService.createTable(c, a, { name: str(p, "name"), displayName: p.displayName as string | undefined, description: p.description as string | undefined, fields: Array.isArray(p.fields) ? p.fields : [] }));
      action("data.add_field", (c, a, p) => dataService.addField(c, a, str(p, "table"), p.field));
      action("data.update_field", (c, a, p) => dataService.updateField(c, a, str(p, "table"), str(p, "field"), { displayName: p.displayName as string | undefined, description: p.description as string | null | undefined, required: p.required as boolean | undefined, choices: p.choices as string[] | undefined }));
      action("data.remove_field", (c, a, p) => dataService.removeField(c, a, str(p, "table"), str(p, "field")));
      action("data.drop_table", (c, a, p) => dataService.dropTable(c, a, str(p, "table")));
      action("data.rename_table", (c, a, p) => dataService.renameTable(c, a, str(p, "table"), str(p, "newName")));
      action("data.insert", (c, a, p) => dataService.insert(c, a, str(p, "table"), Array.isArray(p.rows) ? p.rows : []));
      action("data.update", (c, a, p) => dataService.update(c, a, str(p, "table"), { ids: p.ids as string[] | undefined, where: p.where }, (p.patch ?? {}) as Record<string, unknown>));
      action("data.delete", (c, a, p) => dataService.delete(c, a, str(p, "table"), { ids: p.ids as string[] | undefined, where: p.where }));
      action("data.sql_select", (c, a, p) => dataService.sqlSelect(c, a, str(p, "sql"), Array.isArray(p.params) ? p.params : []));
      action("data.grants", async (c, a) => {
        const [settings, grants, agents] = await Promise.all([dataService.getSettings(c, a), dataService.listAgentGrants(c, a), ctx.agents.list({ companyId: c })]);
        return { settings, grants, agents: agents.map((agent) => ({ id: agent.id, name: agent.name, status: agent.status })) };
      });
      action("data.set_agent_grant", (c, a, p) => dataService.setAgentGrant(c, a, str(p, "agentId"), parseLevel(p.level)));
      action("data.set_settings", (c, a, p) => dataService.setSettings(c, a, { defaultAgentLevel: p.defaultAgentLevel === undefined ? undefined : parseLevel(p.defaultAgentLevel), hardDelete: p.hardDelete as boolean | undefined }));
      // ---- managed skills ----
      // Both skills are imported into a company's skill library (never enabled
      // on an agent — that stays a per-agent choice on the agent's Skills tab).
      // `reconcile` is idempotent, so every path below may repeat it: the
      // board-only `skills.install` route (`kyoube ensure-plugins`, each
      // container start), the first `data.access` read for a company, the
      // `company.created` event, and the Data-access page's button. All of them
      // run inside a host-issued invocation scoped to the company, which is what
      // the host requires for `skills.managed.reconcile` — the worker's own
      // start-up code has no such scope and cannot do this.
      const installSkills = async (companyId: string) => ({
        data: await ctx.skills.managed.reconcile(DATA_SKILL_KEY, companyId),
        apps: await ctx.skills.managed.reconcile(APPS_SKILL_KEY, companyId),
      });
      installSkillsForCompany = installSkills;
      const skillsInstalled = new Set<string>();
      const ensureSkillsOnce = async (companyId: string) => {
        if (skillsInstalled.has(companyId)) return;
        try {
          await installSkills(companyId);
          skillsInstalled.add(companyId);
        } catch (error) {
          // The read or event that triggered this must still succeed; the next
          // touch of the company tries again.
          ctx.logger.warn("Kyoube skill install failed for a company", { companyId, error: String(error) });
        }
      };
      ctx.events.on("company.created", async (event) => {
        await ensureSkillsOnce(event.companyId);
      });

      action("data.setup_company", async (c, a) => {
        await dataService.getSettings(c, a); // admin gate
        await dataService.scope(c);
        const result = await installSkills(c);
        skillsInstalled.add(c);
        return result;
      });

      // ---- Apps (same actor rules; AppService enforces read/write/schema) ----
      action("apps.list", (c, a) => appService.list(c, a));
      action("apps.get", (c, a, p) => appService.get(c, a, str(p, "slug"), versionRef(p)));
      action("apps.create", (c, a, p) => appService.create(c, a, p.manifest, p.source, optionalNotes(p)));
      action("apps.update", (c, a, p) => appService.update(c, a, str(p, "slug"), p.manifest, p.source, optionalNotes(p)));
      action("apps.publish", (c, a, p) => appService.publish(c, a, str(p, "slug"), optionalVersionNumber(p)));
      action("apps.rollback", (c, a, p) => appService.rollback(c, a, str(p, "slug"), versionNumber(p)));
      action("apps.archive", (c, a, p) => appService.archive(c, a, str(p, "slug")));
      // The runner has no viewer name to show yet (the action context carries
      // ids, not display names), so the app sees an empty one.
      action("apps.runtime", (c, a, p) => appService.runtime(c, a, str(p, "slug"), ""));
      // One action for every data call a running app makes. The method is
      // narrowed here — before the service — so a page cannot name anything
      // outside the runtime surface; `params` stays opaque JSON that
      // AppService checks against the app's declared tables.
      action("apps.data", (c, a, p) => appService.runtimeData(c, a, str(p, "slug"), parseRuntimeMethod(p.method), (p.params ?? {}) as Params));

      // ---- maintenance ----
      ctx.jobs.register(PURGE_JOB_KEY, async () => {
        const companies = await dbPool.query<{ company_id: string }>("SELECT company_id FROM kyoube_meta.companies");
        for (const row of companies.rows) {
          // One company's broken schema must not cancel the nightly sweep for
          // every company after it, so each purge is isolated.
          try {
            // `purgeTrash` runs under the plugin-internal system actor (see
            // `systemActor()` in data/service.ts); no external actor reaches it.
            const result = await dataService.purgeTrash(row.company_id);
            if (result.droppedTables.length + result.droppedColumns.length > 0) ctx.logger.info("purged trash", { companyId: row.company_id, ...result });
          } catch (error) {
            ctx.logger.error("purge failed", { companyId: row.company_id, error: String(error) });
          }
        }
      });

      ctx.logger.info(`${PLUGIN_ID} worker ready`);
    },

    async onApiRequest(input) {
      // Ruling P3-R8: both halves of the surface are served from this closure
      // and both answer 503 until setup has run — with one body, since the
      // caller of an `/apps` route was never asking for "the data service".
      const dataService = service;
      const appService = apps;
      if (!dataService || !appService) return { status: 503, body: { error: "plugin not ready" } };
      // Ruling P2-R24: the raw error stays out of the response; the operator log
      // gets it instead (via the logger captured during `setup`).
      const log = logger;
      const onError = log ? (message: string, meta?: Record<string, unknown>) => log.error(message, meta) : undefined;
      if (input.routeKey === "skills.install") {
        // Declared `auth: "board"`, which the host enforces before the request
        // reaches this worker (a board key arrives here as a user actor);
        // checked again so a mis-declared route could never let an agent run
        // the import.
        if (input.actor.actorType === "agent") return { status: 403, body: { error: "forbidden: board access required", code: "forbidden" } };
        const install = installSkillsForCompany;
        if (!install) return { status: 503, body: { error: "plugin not ready" } };
        try {
          return { status: 200, body: await install(input.companyId) };
        } catch (error) {
          // Ruling P2-R24 applies here too: the raw error goes to the operator log, not the caller.
          onError?.("skill install failed", { companyId: input.companyId, error: String(error) });
          return { status: 500, body: { error: "error: skill install failed", code: "error" } };
        }
      }
      // The apps dispatcher answers every `apps.*` route and returns null for
      // anything else, so a data route falls through untouched.
      return (await handleAppsApiRequest(appService, input, onError)) ?? handleApiRequest(dataService, input, onError);
    },

    async onHealth() {
      // A worker whose `setup` has not finished (or has shut down) has nothing
      // to serve — `onApiRequest` answers 503 — so it must not report `ok`. The
      // pool is assigned before the migrations run, hence all three are checked.
      if (!pool || !service || !apps) return { status: "degraded", message: `${PLUGIN_ID} not ready` };
      try {
        await pool.query("SELECT 1");
        return { status: "ok", message: `${PLUGIN_ID} ready` };
      } catch (error) {
        return { status: "error", message: error instanceof Error ? error.message : String(error) };
      }
    },

    async onShutdown() {
      try {
        await pool?.end();
      } finally {
        // Cleared even when `end()` rejects: a dying pool must never stay
        // reachable through `onApiRequest`/`onHealth`.
        pool = null;
        service = null;
        apps = null;
        logger = null;
        installSkillsForCompany = null;
      }
    },
  });
}
