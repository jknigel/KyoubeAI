import { definePlugin, type PaperclipPlugin, type PluginContext, type PluginLogger } from "@paperclipai/plugin-sdk";
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk/protocol";
import type { Pool } from "pg";
import { handleApiRequest } from "./api-routes.js";
import { handleAppsApiRequest } from "./apps/api-routes.js";
import { MAX_APP_NOTES } from "./apps/manifest.js";
import { AppService, parseDecideInput, parseRuntimeMethod, type AppServiceDeps } from "./apps/service.js";
import { registerAppTools } from "./apps/tools.js";
import { handleDecisionsApiRequest } from "./decisions/api-routes.js";
import { handleGroupsApiRequest, keptMemberIds } from "./groups/api-routes.js";
import { rulesTokenMatches, RULES_TOKEN_PATH } from "./groups/rules-token.js";
import { AiColumnService } from "./decisions/columns.js";
import { SecretCache } from "./secrets/cache.js";
import { API_KEY_CONFIG_PATH, ProviderResolver, validateDecisionsConfig } from "./decisions/config.js";
import { guardFrom, guardOption } from "./decisions/guardrail.js";
import { Guardrail } from "./decisions/guardrail-service.js";
import { purgeGuardrailHolds } from "./decisions/holds.js";
import { DecisionService, type DecisionServiceDeps } from "./decisions/service.js";
import { purgeDecisionData } from "./decisions/store.js";
import { registerDecisionTools } from "./decisions/tools.js";
import { DataError } from "./data/errors.js";
import { parseLevel, type DataActor } from "./data/permissions.js";
import { DataService, type DataServiceDeps, type MutationEvent } from "./data/service.js";
import { GroupService } from "./groups/service.js";
import { levelSource } from "./groups/levels.js";
import { fileLicenceGate, type LicenceGate } from "./groups/licence.js";
import { runMetaMigrations } from "./db/migrate.js";
import { createPool as defaultCreatePool } from "./db/pool.js";
import type { KyoubeRuntimeConfig } from "./kyoube-config.js";
import { APPS_SKILL_KEY, DATA_SKILL_KEY, DECISIONS_SKILL_KEY, FILL_JOB_KEY, PLUGIN_ID, PURGE_JOB_KEY } from "./manifest.js";
import { RoleResolver } from "./roles.js";
import { registerTools } from "./tools.js";

export interface AppsPluginDeps {
  loadKyoubeConfig: () => Promise<KyoubeRuntimeConfig>;
  migrationsDir: string;
  createPool?: (url: string) => Pool;
  migrate?: (pool: Pool, dir: string) => Promise<unknown>;
  createService?: (deps: DataServiceDeps) => DataService;
  createAppService?: (deps: AppServiceDeps) => AppService;
  createDecisionService?: (deps: DecisionServiceDeps) => DecisionService;
  /** Whether this instance may manage groups; tests pass a fake, production reads the licence files. */
  licence?: LicenceGate;
  /** Where the kyoube CLI's rules token lives (ruling R18); tests point it at a temporary file. */
  rulesTokenPath?: string;
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
  // The group service lives here for the same reason (ruling P2-R5).
  let groups: GroupService | null = null;
  // Host handles the board-only group routes need; onApiRequest runs outside setup.
  let hostMembers: PluginContext["access"]["members"] | null = null;
  let hostAgents: PluginContext["agents"] | null = null;
  let hostRoles: RoleResolver | null = null;
  // The decision service and the provider resolver live in this closure for the same reason the
  // other services do (ruling P2-R5); `onConfigChanged` drops the resolver's cached keys.
  let decisions: DecisionService | null = null;
  let providers: ProviderResolver | null = null;
  // One secret cache for every secret the plugin reads; never module-level, so each worker setup starts cold.
  let secretCache: SecretCache | null = null;
  let logger: PluginLogger | null = null;
  // The skill import the `skills.install` route runs; lives here for the same
  // reason the services do (`onApiRequest` runs outside `setup`).
  let installSkillsForCompany: ((companyId: string) => Promise<unknown>) | null = null;

  return definePlugin({
    // One worker serves every company's config (typed-decisions provider per company).
    multiCompanyConfig: true,

    async onConfigChanged(_config, context) {
      // Config is read per call; only the cached key has to go so a rotated key is used at once.
      secretCache?.invalidate(context?.companyId ?? null);
    },

    async onValidateConfig(config) {
      return validateDecisionsConfig(config);
    },

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
      const groupService = new GroupService({
        pool: dbPool,
        resolveUserRole: (companyId, userId, fresh) => (fresh ? roles.resolveFresh(companyId, userId) : roles.resolveRole(companyId, userId)),
        licence: deps.licence ?? fileLicenceGate(),
        onMutation: dataActivity.log,
        onMutationError: dataActivity.onError,
      });
      groups = groupService;
      hostMembers = ctx.access.members;
      hostAgents = ctx.agents;
      hostRoles = roles;
      const dataService = (deps.createService ?? ((serviceDeps) => new DataService(serviceDeps)))({
        pool: dbPool,
        // Ruling P4-R13: a schema, grant or settings change asks the host again; everything else
        // takes the 30 s cache.
        resolveUserRole: (companyId, userId, fresh) => (fresh ? roles.resolveFresh(companyId, userId) : roles.resolveRole(companyId, userId)),
        onMutation: dataActivity.log,
        onMutationError: dataActivity.onError,
        groupLevels: (companyId, userId) => groupService.levelsForUser(companyId, userId),
      });
      service = dataService;
      const cache = new SecretCache({
        resolve: (ref, companyId, configPath) => ctx.secrets.resolve(ref as never, { companyId, configPath }),
      });
      secretCache = cache;
      const providerResolver = new ProviderResolver({
        cache,
        getConfig: (companyId) => ctx.config.get(companyId),
        resolveSecret: (ref, companyId) => ctx.secrets.resolve(ref as never, { companyId, configPath: API_KEY_CONFIG_PATH }),
      });
      providers = providerResolver;
      const decisionService = (deps.createDecisionService ?? ((decisionDeps) => new DecisionService(decisionDeps)))({
        pool: dbPool,
        data: dataService,
        providers: providerResolver,
        // Host-side fetch: the core resolves DNS, refuses private addresses and traces the call.
        fetch: (url, init) => ctx.http.fetch(url, init),
        onActivity: async (event) => {
          await ctx.activity.log({
            companyId: event.companyId,
            message: `Kyoube decisions: ${event.summary}`,
            entityType: "kyoube_decision",
            entityId: event.entityId,
            metadata: { surface: event.surface, via: event.via, actorKind: event.actor.kind, actorId: event.actor.id, runId: event.actor.runId ?? null },
          });
        },
        onActivityError: (error, event) => ctx.logger.warn("decisions activity log failed", { companyId: event.companyId, surface: event.surface, error: String(error) }),
        log: (message, meta) => ctx.logger.warn(message, meta),
      });
      decisions = decisionService;
      registerDecisionTools(ctx, decisionService);
      // The guardrail on risky agent actions: one instance, handed to both services, so every
      // agent path (REST, tools, actions) is checked the same way and none can bypass it.
      const guardrail = new Guardrail({
        pool: dbPool,
        decisions: decisionService,
        issues: {
          get: (issueId, companyId) => ctx.issues.get(issueId, companyId),
          requestConfirmation: (issueId, interaction, companyId) => ctx.issues.requestConfirmation(issueId, interaction as never, companyId),
          listInteractions: (issueId, companyId) => ctx.issues.listInteractions(issueId, companyId),
        },
        agentName: async (agentId, companyId) => (await ctx.agents.get(agentId, companyId))?.name ?? null,
        log: (message, meta) => ctx.logger.warn(message, meta),
      });
      dataService.attach({ guardAgentAction: guardrail.check });
      // The apps service resolves every caller's level through this same
      // DataService, so an app can only ever narrow its viewer's access.
      const appService = (deps.createAppService ?? ((appDeps) => new AppService(appDeps)))({
        pool: dbPool,
        data: dataService,
        decisions: decisionService,
        onMutation: appsActivity.log,
        onMutationError: appsActivity.onError,
        hiddenApps: (companyId, userId) => groupService.hiddenApps(companyId, userId),
        guardAgentAction: guardrail.check,
      });
      apps = appService;
      // AI columns (docs/decisions.md). DataService gets them late, through attach(), because
      // DecisionService depends on DataService.
      const aiColumns = new AiColumnService({
        pool: dbPool,
        data: dataService,
        decisions: decisionService,
        providerName: async (companyId) => (await providerResolver.settings(companyId).catch(() => null))?.provider ?? null,
        log: (message, meta) => ctx.logger.warn(message, meta),
      });
      dataService.attach({ aiColumns: aiColumns.hooks() });

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
      ctx.data.register("data.ai_cells", async (params) => dataService.aiCells(str(params, "companyId"), readActor(params), str(params, "table"),
        Array.isArray(params.rowIds) ? params.rowIds.filter((id): id is string => typeof id === "string") : []));
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
      // The actor may be an agent as well as a person, so the actions the guardrail covers take its
      // `issueId` and `confirmationId` too; a person's call carries neither and is never checked.
      const action = (key: string, fn: (companyId: string, actor: DataActor, params: Params) => Promise<unknown>) =>
        ctx.actions.register(key, async (params, context) => fn(companyOf(context, params), actorFromAction(context), params));

      action("data.create_table", (c, a, p) => dataService.createTable(c, a, { name: str(p, "name"), displayName: p.displayName as string | undefined, description: p.description as string | undefined, fields: Array.isArray(p.fields) ? p.fields : [] }));
      action("data.add_field", (c, a, p) => dataService.addField(c, a, str(p, "table"), p.field));
      action("data.update_field", (c, a, p) => dataService.updateField(c, a, str(p, "table"), str(p, "field"), { displayName: p.displayName as string | undefined, description: p.description as string | null | undefined, required: p.required as boolean | undefined, choices: p.choices as string[] | undefined, decision: p.decision }));
      action("data.remove_field", (c, a, p) => dataService.removeField(c, a, str(p, "table"), str(p, "field"), guardFrom(p)));
      action("data.drop_table", (c, a, p) => dataService.dropTable(c, a, str(p, "table"), guardFrom(p)));
      action("data.rename_table", (c, a, p) => dataService.renameTable(c, a, str(p, "table"), str(p, "newName"), guardFrom(p)));
      action("data.refill_ai_column", (c, a, p) => dataService.refillAiColumn(c, a, str(p, "table"), str(p, "field")));
      action("data.insert", (c, a, p) => dataService.insert(c, a, str(p, "table"), Array.isArray(p.rows) ? p.rows : []));
      action("data.update", (c, a, p) => dataService.update(c, a, str(p, "table"), { ids: p.ids as string[] | undefined, where: p.where }, (p.patch ?? {}) as Record<string, unknown>, undefined, guardFrom(p)));
      action("data.delete", (c, a, p) => dataService.delete(c, a, str(p, "table"), { ids: p.ids as string[] | undefined, where: p.where }, undefined, guardFrom(p)));
      action("data.sql_select", (c, a, p) => dataService.sqlSelect(c, a, str(p, "sql"), Array.isArray(p.params) ? p.params : []));
      action("data.grants", async (c, a) => {
        const [settings, grants, agents] = await Promise.all([dataService.getSettings(c, a), dataService.listAgentGrants(c, a), ctx.agents.list({ companyId: c })]);
        return { settings, grants, agents: agents.map((agent) => ({ id: agent.id, name: agent.name, status: agent.status })) };
      });
      action("data.set_agent_grant", (c, a, p) => dataService.setAgentGrant(c, a, str(p, "agentId"), parseLevel(p.level)));
      action("data.set_settings", (c, a, p) => dataService.setSettings(c, a, { defaultAgentLevel: p.defaultAgentLevel === undefined ? undefined : parseLevel(p.defaultAgentLevel), hardDelete: p.hardDelete as boolean | undefined }));
      // ---- groups (docs/groups.md) ----
      action("groups.list", (c, a) => groupService.list(c, a));
      action("groups.save", (c, a, p) => groupService.save(c, a, p.group));
      action("groups.delete", (c, a, p) => groupService.remove(c, a, str(p, "id")));
      // What the pickers offer: company members, agents and live apps. Same gate as the list.
      // Member rows carry ids and roles only (no name or email), so the pickers show ids.
      action("groups.options", async (c, a) => {
        await groupService.list(c, a);
        const [members, agents, appList] = await Promise.all([ctx.access.members.list({ companyId: c }), ctx.agents.list({ companyId: c }), appService.list(c, a)]);
        return {
          members: members.filter((m) => m.principalType === "user" && m.status === "active").map((m) => ({ id: m.principalId, role: m.membershipRole })),
          agents: agents.filter((agent) => agent.status !== "terminated").map((agent) => ({ id: agent.id, name: agent.name })),
          apps: appList.filter((app) => app.status !== "archived").map((app) => ({ id: app.id, name: app.name, icon: app.icon })),
        };
      });
      // The Data access page's people table: each active member's effective level and where it comes from.
      action("groups.people_levels", async (c, a) => {
        await dataService.assertAdmin(c, a);
        const members = (await ctx.access.members.list({ companyId: c })).filter((m) => m.principalType === "user" && m.status === "active");
        const all = await groupService.list(c, a);
        return Promise.all(members.map(async (m) => {
          const level = await dataService.levelFor(c, { kind: "user", id: m.principalId, runId: null });
          const levelled = all.groups.filter((g) => g.dataLevel && g.members.includes(m.principalId)).map((g) => g.name);
          return { userId: m.principalId, role: m.membershipRole, level, source: levelSource(m.membershipRole, levelled) };
        }));
      });
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
        decisions: await ctx.skills.managed.reconcile(DECISIONS_SKILL_KEY, companyId),
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
      action("apps.publish", (c, a, p) => appService.publish(c, a, str(p, "slug"), optionalVersionNumber(p), { decisionsConfirmed: p.decisionsConfirmed === true, ...guardOption(p) }));
      action("apps.rollback", (c, a, p) => appService.rollback(c, a, str(p, "slug"), versionNumber(p), { decisionsConfirmed: p.decisionsConfirmed === true, ...guardOption(p) }));
      action("apps.archive", (c, a, p) => appService.archive(c, a, str(p, "slug"), guardOption(p)));
      // The runner has no viewer name to show yet (the action context carries
      // ids, not display names), so the app sees an empty one.
      action("apps.runtime", (c, a, p) => appService.runtime(c, a, str(p, "slug"), ""));
      // One action for every data call a running app makes. The method is
      // narrowed here — before the service — so a page cannot name anything
      // outside the runtime surface; `params` stays opaque JSON that
      // AppService checks against the app's declared tables.
      action("apps.data", (c, a, p) => appService.runtimeData(c, a, str(p, "slug"), parseRuntimeMethod(p.method), (p.params ?? {}) as Params));
      // Typed decisions from a running app (docs/decisions.md). `set` and `input` arrive from app
      // code through the bridge; `parseDecideInput` and AppService check them before anything runs.
      action("apps.decide", (c, a, p) => appService.runtimeDecide(c, a, str(p, "slug"), str(p, "set"), parseDecideInput(p.input)));
      action("apps.decision_outcome", (c, a, p) => appService.decideOutcome(c, a, str(p, "slug"), str(p, "decisionId"), str(p, "question"), p.value));
      action("apps.publish_preview", (c, a, p) => appService.publishPreview(c, a, str(p, "slug"), p.version === undefined || p.version === null || p.version === "latest" ? "latest" : versionNumber(p)));

      // ---- typed decisions (same actor rules; DecisionService checks the admin gate) ----
      action("decisions.settings", (c, a) => decisionService.getSettings(c, a));
      // Only the five settings are passed on: the host adds its own keys (`companyId`, and possibly
      // others) to every action's params, and the service's schema is strict.
      const DECISION_SETTING_KEYS = ["agents", "columns", "apps", "guardrail", "dailyCap"] as const;
      action("decisions.set_settings", (c, a, p) => decisionService.setSettings(c, a,
        Object.fromEntries(DECISION_SETTING_KEYS.filter((key) => p[key] !== undefined).map((key) => [key, p[key]]))));

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
            const orphans = await aiColumns.purgeOrphans(row.company_id);
            if (orphans > 0) ctx.logger.info("purged AI cells of deleted rows", { companyId: row.company_id, cells: orphans });
          } catch (error) {
            ctx.logger.error("purge failed", { companyId: row.company_id, error: String(error) });
          }
        }
        try {
          const purged = await purgeDecisionData(dbPool);
          if (purged.decisions + purged.usage > 0) ctx.logger.info("purged old decision log rows", purged);
          const holds = await purgeGuardrailHolds(dbPool);
          if (holds > 0) ctx.logger.info("purged expired guardrail holds", { holds });
        } catch (error) {
          ctx.logger.error("decision log purge failed", { error: String(error) });
        }
      });
      ctx.jobs.register(FILL_JOB_KEY, async () => {
        const reports = await aiColumns.runJob();
        const decided = reports.reduce((sum, report) => sum + report.decided, 0);
        if (decided > 0) ctx.logger.info("filled AI columns", { companies: reports.length, decided });
      });

      ctx.logger.info(`${PLUGIN_ID} worker ready`);
    },

    async onApiRequest(input) {
      // Ruling P3-R8: both halves of the surface are served from this closure
      // and both answer 503 until setup has run — with one body, since the
      // caller of an `/apps` route was never asking for "the data service".
      const dataService = service;
      const appService = apps;
      const decisionService = decisions;
      if (!dataService || !appService || !decisionService) return { status: 503, body: { error: "plugin not ready" } };
      // Ruling P2-R24: the raw error stays out of the response; the operator log
      // gets it instead (via the logger captured during `setup`).
      const log = logger;
      const onError = log ? (message: string, meta?: Record<string, unknown>) => log.error(message, meta) : undefined;
      const groupService = groups;
      const members = hostMembers;
      const agentsHost = hostAgents;
      const roleHost = hostRoles;
      if (groupService && members && agentsHost && roleHost) {
        const handled = await handleGroupsApiRequest(groupService, input, {
          listUserIds: (c) => keptMemberIds(members, c),
          listAgentIds: async (c) => new Set((await agentsHost.list({ companyId: c })).filter((a) => a.status !== "terminated").map((a) => a.id)),
          resolveRoleFresh: (c, u) => roleHost.resolveFresh(c, u),
          rulesTokenMatches: (presented) => rulesTokenMatches(deps.rulesTokenPath ?? RULES_TOKEN_PATH, presented),
        }, onError);
        if (handled) return handled;
      }
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
      return (await handleAppsApiRequest(appService, input, onError))
        ?? (await handleDecisionsApiRequest(decisionService, input, onError))
        ?? handleApiRequest(dataService, input, onError);
    },

    async onHealth() {
      // A worker whose `setup` has not finished (or has shut down) has nothing
      // to serve — `onApiRequest` answers 503 — so it must not report `ok`. The
      // pool is assigned before the migrations run, hence all three are checked.
      if (!pool || !service || !apps || !decisions) return { status: "degraded", message: `${PLUGIN_ID} not ready` };
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
        decisions = null;
        providers = null;
        secretCache = null;
        logger = null;
        installSkillsForCompany = null;
        hostMembers = null;
        hostAgents = null;
        groups = null;
      }
    },
  });
}
