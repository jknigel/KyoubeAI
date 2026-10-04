import type { Pool } from "pg";
import type { AuditEntry } from "../data/audit.js";
import { DataError } from "../data/errors.js";
import { coerceValue } from "../data/field-kinds.js";
import type { QuerySpec } from "../data/filter.js";
import { assertLevel, levelAllows, type AccessLevel, type DataActor, type Operation } from "../data/permissions.js";
import { UUID_RE, type Row, type RowTarget } from "../data/records-service.js";
import type { TableInfo } from "../data/schema-service.js";
import type { DataService, MutationEvent } from "../data/service.js";
import { schemaNameFor } from "../db/company-scope.js";
import { QUESTION_KEY_RE, type DecideResult, type Question } from "../decisions/contract.js";
import type { DecisionService } from "../decisions/service.js";
import { getLoggedDecision, recordOutcome, type Outcome } from "../decisions/store.js";
import { assertAppSource, decisionSetsChanged, validateAppManifest, type AppManifest } from "./manifest.js";
import { AppStore, type AppRecord, type AppVersion } from "./store.js";

/** What a running app is told about itself, its viewer, and the tables it may touch. */
export interface AppContext {
  companyId: string;
  viewer: { id: string | null; name: string; level: AccessLevel };
  app: { slug: string; name: string; version: number };
  tables: string[];
  /** The decision sets this version declares, and whether the company lets apps use them right now. */
  decisions: { available: boolean; sets: string[] };
}

export type RuntimeMethod = "query" | "get" | "count" | "describe" | "insert" | "update" | "delete";
export const RUNTIME_METHODS: readonly RuntimeMethod[] = ["query", "get", "count", "describe", "insert", "update", "delete"];
const WRITE_METHODS: readonly RuntimeMethod[] = ["insert", "update", "delete"];

/**
 * Narrows an untrusted `method` (it arrives from a running app, through the
 * host bridge) to the runtime's own surface, so a boundary can reject an
 * unknown name — `sqlSelect`, say — before `AppService` is called at all.
 * Mirrors `parseLevel` in data/permissions.ts.
 */
export function parseRuntimeMethod(value: unknown): RuntimeMethod {
  if (typeof value === "string" && (RUNTIME_METHODS as readonly string[]).includes(value)) return value as RuntimeMethod;
  throw new DataError("invalid", `unknown app data method "${String(value)}"`);
}

export interface AppServiceDeps {
  pool: Pool;
  data: DataService;
  /** Typed decisions (docs/decisions.md). Absent, an app's decision calls answer `disabled`. */
  decisions?: Pick<DecisionService, "decide" | "status">;
  onMutation?: (event: MutationEvent) => Promise<void>;
  onMutationError?: (error: unknown, event: MutationEvent) => void;
  /** The clock `decideOutcome` measures its 24-hour window with; tests replace it. */
  now?: () => number;
}

/** What publishing and rolling back accept besides the version. Milestone 4 adds `guard` here. */
export interface PublishOptions {
  /** The publisher reviewed the version's new or changed decision sets and what they send. */
  decisionsConfirmed?: boolean;
}

export type DecideInputRef = { rowId: string } | { values: Record<string, unknown> };

/**
 * Narrows what a running app sent as `input` to one of the two shapes `runtimeDecide` takes. It
 * arrives from app code through the bridge, so it is checked rather than cast.
 */
export function parseDecideInput(raw: unknown): DecideInputRef {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DataError("invalid", "decide needs { rowId } or { values }");
  const input = raw as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length === 1 && typeof input.rowId === "string" && input.rowId.length > 0) return { rowId: input.rowId };
  if (keys.length === 1 && input.values && typeof input.values === "object" && !Array.isArray(input.values)) return { values: input.values as Record<string, unknown> };
  throw new DataError("invalid", "decide needs exactly one of { rowId } or { values }");
}

/** How long an app may report what its viewer chose for one of its decisions. */
export const OUTCOME_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface PublishPreview {
  version: number;
  /** The version adds or changes decision sets: a person must publish it, with `decisionsConfirmed`. */
  changed: boolean;
  provider: string | null;
  available: boolean;
  sets: Array<{ key: string; table: string; fields: string[]; advisory: boolean; questions: Array<{ key: string; type: Question["type"]; text: string }> }>;
}

// ---- runtime parameter shapes ------------------------------------------
// An app's data calls arrive as untyped JSON written by an agent-built page,
// so every value below is checked before it reaches DataService rather than
// cast: the query compiler calls .map on `fields`/`orderBy` and indexes
// `where`, so a wrong shape has to surface as an "invalid" DataError here
// instead of a TypeError escaping the DataError contract.

function str(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) throw new DataError("invalid", `${key} is required`);
  return value;
}

function optionalArray(params: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new DataError("invalid", `${key} must be an array`);
  return value;
}

function stringArray(params: Record<string, unknown>, key: string): string[] | undefined {
  return optionalArray(params, key)?.map((entry) => {
    if (typeof entry !== "string") throw new DataError("invalid", `${key} must be an array of strings`);
    return entry;
  });
}

function optionalNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new DataError("invalid", `${key} must be a number`);
  return value;
}

function sortDirection(value: unknown): "asc" | "desc" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "asc" || value === "desc") return value;
  throw new DataError("invalid", "orderBy direction must be asc or desc");
}

function querySpec(params: Record<string, unknown>): QuerySpec {
  const orderBy = optionalArray(params, "orderBy")?.map((entry) => {
    if (typeof entry !== "object" || entry === null) throw new DataError("invalid", "orderBy must be an array of objects");
    const { field, direction } = entry as { field?: unknown; direction?: unknown };
    if (typeof field !== "string") throw new DataError("invalid", "each orderBy entry needs a field name");
    return { field, direction: sortDirection(direction) };
  });
  return { where: params.where, orderBy, limit: optionalNumber(params, "limit"), offset: optionalNumber(params, "offset"), fields: stringArray(params, "fields") };
}

function rowTarget(params: Record<string, unknown>): RowTarget {
  return { ids: stringArray(params, "ids"), where: params.where };
}

function patch(params: Record<string, unknown>): Row {
  const value = params.patch;
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new DataError("invalid", "patch must be an object");
  return value as Row;
}

/**
 * The actor-aware app service: the only way in to apps for the UI, the tools,
 * and the API routes. It resolves the caller's access level through
 * `DataService` (users by company role, agents by grant), authorises the
 * lifecycle operation, and — for a running app — proxies data calls with the
 * *viewer's own* actor, so an app's manifest can only ever narrow what its
 * viewer may do, never widen it.
 */
export class AppService {
  private readonly pool: Pool;
  private readonly store: AppStore;
  private readonly data: DataService;
  private readonly decisions: AppServiceDeps["decisions"];
  private readonly onMutation: AppServiceDeps["onMutation"];
  private readonly onMutationError: AppServiceDeps["onMutationError"];
  private readonly now: () => number;

  constructor(deps: AppServiceDeps) {
    this.pool = deps.pool;
    this.data = deps.data;
    this.store = new AppStore(deps.pool);
    this.decisions = deps.decisions;
    this.onMutation = deps.onMutation;
    this.onMutationError = deps.onMutationError;
    this.now = deps.now ?? Date.now;
  }

  /** Live apps for this company: drafts are visible only to those who can edit them. */
  async list(companyId: string, actor: DataActor): Promise<AppRecord[]> {
    const level = await this.authorize(companyId, actor, "read", "list apps");
    const all = await this.store.list(companyId);
    return levelAllows(level, "write") ? all : all.filter((app) => app.status === "published");
  }

  async get(companyId: string, actor: DataActor, slug: string, version: number | "current" | "latest" = "latest"): Promise<{ app: AppRecord; version: AppVersion | null }> {
    const level = await this.authorize(companyId, actor, "read", "read an app");
    const editor = levelAllows(level, "write");
    const app = await this.store.get(companyId, slug);
    if (!app || (app.status !== "published" && !editor)) throw new DataError("not_found", `app "${slug}" not found`);
    // Read access buys the published app and nothing behind it: a viewer's
    // "latest" is the published version, and any other version number is a
    // miss. Without this, read access to one published app would also hand
    // out the source of every unpublished draft version stacked behind it.
    const wanted = editor || version !== "latest" ? version : "current";
    const record = await this.store.getVersion(app, wanted);
    if (record && !editor && record.version !== app.currentVersion) throw new DataError("not_found", `app "${slug}" has no version ${String(version)}`);
    return { app, version: record };
  }

  async create(companyId: string, actor: DataActor, rawManifest: unknown, rawSource: unknown, notes: string | null = null): Promise<{ app: AppRecord; version: AppVersion }> {
    await this.authorize(companyId, actor, "write", "create an app");
    const manifest = validateAppManifest(rawManifest);
    const source = assertAppSource(rawSource);
    await this.assertDecisionFields(companyId, actor, manifest, true);
    const created = await this.store.create(companyId, manifest, source, { kind: actor.kind, id: actor.id }, notes,
      (result) => this.entry(companyId, actor, "app_create", result.app, { version: result.version.version }));
    await this.notify(companyId, actor, "app_create", created.app, `created app ${manifest.slug} (draft)`);
    return created;
  }

  /** Saves a new version. It stays a draft until someone with schema access publishes it. */
  async update(companyId: string, actor: DataActor, slug: string, rawManifest: unknown, rawSource: unknown, notes: string | null = null): Promise<AppVersion> {
    await this.authorize(companyId, actor, "write", "update an app");
    const manifest = validateAppManifest(rawManifest);
    if (manifest.slug !== slug) throw new DataError("invalid", "the manifest slug must match the app being updated");
    const source = assertAppSource(rawSource);
    await this.assertDecisionFields(companyId, actor, manifest, true);
    const saved = await this.store.addVersion(companyId, slug, manifest, source, { kind: actor.kind, id: actor.id }, notes,
      (result) => this.entry(companyId, actor, "app_update", result.app, { version: result.version.version }));
    await this.notify(companyId, actor, "app_update", saved.app, `saved app ${slug} version ${saved.version.version} (draft)`);
    return saved.version;
  }

  // Ruling P4-R13: publish, rollback and archive change what every viewer of this company runs,
  // so each takes a fresh role lookup rather than up to 30 s of cached membership.
  async publish(companyId: string, actor: DataActor, slug: string, version?: number, opts: PublishOptions = {}): Promise<AppRecord> {
    await this.authorize(companyId, actor, "schema", "publish an app", { fresh: true });
    const published = await this.makeCurrent(companyId, actor, slug, version ?? "latest", "app_publish", opts);
    await this.notify(companyId, actor, "app_publish", published.app, `published app ${slug} version ${published.version}`);
    return published.app;
  }

  async rollback(companyId: string, actor: DataActor, slug: string, version: number, opts: PublishOptions = {}): Promise<AppRecord> {
    await this.authorize(companyId, actor, "schema", "roll back an app", { fresh: true });
    const rolled = await this.makeCurrent(companyId, actor, slug, version, "app_rollback", opts);
    await this.notify(companyId, actor, "app_rollback", rolled.app, `rolled app ${slug} back to version ${rolled.version}`);
    return rolled.app;
  }

  /** Terminal in Phase 3 (ruling P3-R10): the app disappears and its slug is free again. */
  async archive(companyId: string, actor: DataActor, slug: string): Promise<AppRecord> {
    await this.authorize(companyId, actor, "schema", "archive an app", { fresh: true });
    const app = await this.store.setStatus(companyId, slug, "archived",
      (archived) => this.entry(companyId, actor, "app_archive", archived, {}));
    await this.notify(companyId, actor, "app_archive", app, `archived app ${slug}`);
    return app;
  }

  /** The published page a viewer runs, plus the context handed to it. */
  async runtime(companyId: string, actor: DataActor, slug: string, viewerName: string): Promise<{ context: AppContext; source: string }> {
    const { app, version, level } = await this.open(companyId, actor, slug);
    const sets = Object.keys(version.manifest.decisions ?? {});
    let available = false;
    if (sets.length > 0 && this.decisions) {
      // A context is never refused over this: an app that cannot use its sets right now still runs.
      try { available = (await this.decisions.status(companyId, actor, "apps")).available; } catch { available = false; }
    }
    return {
      context: {
        companyId,
        viewer: { id: actor.id, name: viewerName, level },
        app: { slug: app.slug, name: app.name, version: version.version },
        tables: version.manifest.tables.map((table) => table.name),
        decisions: { available, sets },
      },
      source: version.source,
    };
  }

  /**
   * One data call from a running app. Three gates, in order: the app must be
   * published to this viewer, the *current published* version must declare the
   * table (a table declared only by a newer draft is not reachable), and a
   * write needs that declaration to be "readwrite". Only then does the call go
   * to `DataService` under the viewer's own actor, which authorises, audits,
   * and logs it there — the manifest can narrow the viewer's access, never
   * widen it, and this method never re-audits what DataService already did.
   */
  async runtimeData(companyId: string, actor: DataActor, slug: string, method: RuntimeMethod, params: Record<string, unknown>): Promise<unknown> {
    if (!RUNTIME_METHODS.includes(method)) throw new DataError("invalid", `unknown app data method "${String(method)}"`);
    if (typeof params !== "object" || params === null) throw new DataError("invalid", "params must be an object");
    const { version } = await this.open(companyId, actor, slug);
    const table = str(params, "table");
    const declared = version.manifest.tables.find((entry) => entry.name === table);
    if (!declared) throw new DataError("forbidden", `app "${slug}" does not declare table "${table}"`);
    if (WRITE_METHODS.includes(method) && declared.access !== "readwrite") throw new DataError("forbidden", `app "${slug}" only has read access to "${table}"`);
    // Ruling P4-R21: the audit row still names the *viewer* as the actor, so the app a write was
    // made through is a separate fact and cannot be inferred from it. It is taken from the
    // published version resolved above — never from the app's own message, which names only a
    // table and a payload.
    const via = { app: slug, version: version.version };
    switch (method) {
      case "describe": return this.data.describeTable(companyId, actor, table);
      case "query": return this.data.query(companyId, actor, table, querySpec(params));
      case "get": return this.data.get(companyId, actor, table, str(params, "id"));
      case "count": return { count: await this.data.count(companyId, actor, table, params.where) };
      case "insert": return this.data.insert(companyId, actor, table, optionalArray(params, "rows") ?? [], via);
      case "update": return this.data.update(companyId, actor, table, rowTarget(params), patch(params), via);
      case "delete": return this.data.delete(companyId, actor, table, rowTarget(params), via);
    }
  }

  /**
   * One typed decision from a running app (docs/decisions.md). Four gates, in order: the app must be
   * published to this viewer, the *current published* version must declare the set, the viewer must
   * be able to read the set's table, and the company must have decisions switched on for apps (the
   * decision service checks that last one). The state is built here, from the set's declared fields
   * and nothing else — read from a stored row under the viewer, or taken from unsaved values checked
   * against each field's kind — so app code can never send free text or extra data of its own.
   */
  async runtimeDecide(companyId: string, actor: DataActor, slug: string, set: string, input: DecideInputRef): Promise<DecideResult> {
    const { version } = await this.open(companyId, actor, slug);
    const sets = version.manifest.decisions ?? {};
    if (!Object.hasOwn(sets, set)) throw new DataError("forbidden", `app "${slug}" does not declare decision set "${set}"`);
    const declared = sets[set]!;
    const info = await this.data.describeTable(companyId, actor, declared.table);
    let state: Record<string, unknown>;
    if ("rowId" in input) {
      const row = await this.data.get(companyId, actor, declared.table, input.rowId);
      if (!row) throw new DataError("not_found", `row ${input.rowId} was not found in "${declared.table}"`);
      state = Object.fromEntries(declared.fields.map((name) => [name, row[name] ?? null]));
    } else {
      const extra = Object.keys(input.values).filter((name) => !declared.fields.includes(name));
      if (extra.length > 0) throw new DataError("invalid", `decision set "${set}" does not send field(s) ${extra.join(", ")}`);
      const fields = new Map(info.fields.map((field) => [field.name, field]));
      state = {};
      for (const name of declared.fields) {
        const field = fields.get(name);
        if (!field) throw new DataError("invalid", `table "${declared.table}" no longer has field "${name}"`);
        // A form being filled in may leave any field empty, whatever the table requires.
        state[name] = coerceValue({ ...field, required: false }, input.values[name]);
      }
    }
    if (!this.decisions) throw new DataError("disabled", "typed decisions are not available in this installation");
    return this.decisions.decide(companyId, actor, "apps", { state, questions: declared.questions }, { via: `${slug}@${version.version}`, advisory: declared.advisory });
  }

  /**
   * What the viewer chose in an app's review lane. Only for a decision this app made for this
   * viewer in the last 24 hours, once; every other case gets the same `not_found`, so the call
   * cannot be used to probe other people's decisions. Logged as `outcome_via: app`, apart from the
   * Data page's outcomes, because app code could call this without a person acting.
   */
  async decideOutcome(companyId: string, actor: DataActor, slug: string, decisionId: string, question: string, value: unknown): Promise<{ outcome: Outcome }> {
    await this.open(companyId, actor, slug);
    if (actor.kind !== "user" || !actor.id) throw new DataError("forbidden", "only the person using an app can record what they chose");
    if (!UUID_RE.test(decisionId)) throw new DataError("invalid", "decisionId must be a uuid");
    if (!QUESTION_KEY_RE.test(question)) throw new DataError("invalid", "question must be a question key");
    if (typeof value !== "string" && typeof value !== "boolean") throw new DataError("invalid", "value must be a string or a boolean");
    const logged = await getLoggedDecision(this.pool, companyId, decisionId, question);
    const ours = logged !== null
      && logged.surface === "apps" && logged.actorKind === "user" && logged.actorId === actor.id
      && (logged.via ?? "").startsWith(`${slug}@`)
      && this.now() - Date.parse(logged.createdAt) <= OUTCOME_WINDOW_MS;
    if (!ours) throw new DataError("not_found", "no decision by this app for you in the last 24 hours matches that id and question");
    const outcome: Outcome = String(value) === logged!.answer ? "human_confirmed" : "human_changed";
    // The write itself refuses a decision that already has an outcome, so of two reports racing for
    // one decision exactly one is recorded and the other is told so.
    if (!(await recordOutcome(this.pool, { companyId, decisionId, questionKey: question, outcome, via: "app", by: actor.id }))) {
      throw new DataError("conflict", "an outcome is already recorded for this decision");
    }
    return { outcome };
  }

  /** What publishing `version` would send, for the publish dialog. Same gate as publishing. */
  async publishPreview(companyId: string, actor: DataActor, slug: string, version: number | "latest" = "latest"): Promise<PublishPreview> {
    await this.authorize(companyId, actor, "schema", "publish an app", { fresh: true });
    const target = await this.store.getVersion(companyId, slug, version);
    if (!target) throw new DataError("not_found", `app "${slug}" has no version ${version}`);
    const current = await this.currentManifest(companyId, slug);
    const sets = target.manifest.decisions ?? {};
    let provider: string | null = null;
    let available = false;
    if (this.decisions && Object.keys(sets).length > 0) {
      try {
        const status = await this.decisions.status(companyId, actor, "apps");
        provider = status.provider;
        available = status.available;
      } catch {
        // The dialog still shows what would be sent; it just cannot name the provider.
      }
    }
    return {
      version: target.version,
      changed: decisionSetsChanged(current, target.manifest),
      provider,
      available,
      sets: Object.entries(sets).map(([key, set]) => ({
        key, table: set.table, fields: set.fields, advisory: set.advisory,
        questions: Object.entries(set.questions).map(([questionKey, question]) => ({ key: questionKey, type: question.type, text: question.type === "check" ? question.statement : question.instructions })),
      })),
    };
  }

  // ---- internals --------------------------------------------------------

  /**
   * The gate every entry point above passes through before touching the
   * store: it validates the companyId, resolves the actor's level through
   * `DataService`, and refuses the call unless that level allows `op`.
   */
  private async authorize(companyId: string, actor: DataActor, op: Operation, what: string, opts: { fresh?: boolean } = {}): Promise<AccessLevel> {
    // The store puts companyId straight into its kyoube_meta queries (Task 1
    // deferred the check to here), so the same uuid rule ensureCompany and
    // withCompany enforce for a company's schema and role is applied first:
    // schemaNameFor throws DataError("invalid", ...) for anything that is not
    // a uuid, before any store or DataService call.
    schemaNameFor(companyId);
    const level = await this.data.levelFor(companyId, actor, opts);
    assertLevel(level, op, what);
    // Ruling P4-R17: `levelFor` no longer provisions, so a write has to ask for it here — the
    // apps tables reference kyoube_meta.companies. A read provisions nothing: the store simply
    // finds no apps for a company that has none.
    if (op !== "read") await this.data.scope(companyId);
    return level;
  }

  /**
   * Points an app at `version` and publishes it, for both `publish` and
   * `rollback`. The declared tables are verified for either path: rolling back
   * lands on the same `setCurrent` (which also flips a draft to published), so
   * without the check here rollback would be a way around publish's rule and
   * could leave viewers an app that can only error. `describeTable` runs as
   * the caller — who holds schema access by the time they get here, and so
   * certainly read access — so it never reads anything they could not read
   * themselves.
   */
  private async makeCurrent(companyId: string, actor: DataActor, slug: string, version: number | "latest", operation: string, opts: PublishOptions = {}): Promise<{ app: AppRecord; version: number }> {
    const target = await this.store.getVersion(companyId, slug, version);
    if (!target) throw new DataError("not_found", `app "${slug}" has no version ${version}`);
    for (const table of target.manifest.tables) await this.data.describeTable(companyId, actor, table.name);
    await this.assertDecisionFields(companyId, actor, target.manifest, false);
    // Spec §5: new or changed decision sets change what leaves the server for every viewer, so a
    // person publishes them, after reviewing what they send — never an agent, whatever its grant.
    const changed = decisionSetsChanged(await this.currentManifest(companyId, slug), target.manifest);
    if (changed && actor.kind !== "user") {
      throw new DataError("forbidden", "decision sets need a person to publish; save the draft and ask a company admin to publish it from the Apps page");
    }
    if (changed && opts.decisionsConfirmed !== true) {
      throw new DataError("invalid", "this version adds or changes decision sets; review what they send, then publish with decisionsConfirmed: true");
    }
    const sets = Object.keys(target.manifest.decisions ?? {});
    const app = await this.store.setCurrent(companyId, slug, target.version,
      (published) => this.entry(companyId, actor, operation, published, { version: target.version, ...(sets.length > 0 ? { decisionSets: sets, decisionsConfirmed: changed } : {}) }));
    return { app, version: target.version };
  }

  /** The manifest viewers run today, or null when the app has never been published. */
  private async currentManifest(companyId: string, slug: string): Promise<AppManifest | null> {
    const app = await this.store.get(companyId, slug);
    if (!app || app.currentVersion === null) return null;
    return (await this.store.getVersion(app, "current"))?.manifest ?? null;
  }

  /**
   * Resolves the published app a viewer may open. Archived apps are already
   * invisible to the store's by-slug lookups (ruling P3-R10), and a draft, an
   * archived app, and a slug that never existed all get the same "not
   * published" answer, so read access cannot be used to probe for drafts.
   */
  /**
   * Every field a decision set may send must exist on its table. At save a table that does not exist
   * yet is skipped (`tolerateMissingTable`) — an app may be drafted before its tables, exactly as
   * declared tables are only checked at publish — and `makeCurrent` checks again with no exceptions.
   * `describeTable` runs as the caller, so this reads nothing they could not read themselves.
   */
  private async assertDecisionFields(companyId: string, actor: DataActor, manifest: AppManifest, tolerateMissingTable: boolean): Promise<void> {
    for (const [key, set] of Object.entries(manifest.decisions ?? {})) {
      let info: TableInfo;
      try {
        info = await this.data.describeTable(companyId, actor, set.table);
      } catch (error) {
        if (tolerateMissingTable && error instanceof DataError && error.code === "not_found") continue;
        throw error;
      }
      const known = new Set(info.fields.map((field) => field.name));
      const missing = set.fields.filter((field) => !known.has(field));
      if (missing.length > 0) {
        throw new DataError("invalid", `decision set "${key}" names field(s) ${missing.join(", ")} that table "${set.table}" does not have`);
      }
    }
  }

  private async open(companyId: string, actor: DataActor, slug: string): Promise<{ app: AppRecord; version: AppVersion; level: AccessLevel }> {
    const level = await this.authorize(companyId, actor, "read", "open an app");
    const app = await this.store.get(companyId, slug);
    const version = app?.status === "published" ? await this.store.getVersion(app, "current") : null;
    if (!app || !version) throw new DataError("not_found", `app "${slug}" is not published`);
    return { app, version, level };
  }

  /**
   * The audit row for one lifecycle change. Ruling P4-R28: it is never written here — it is
   * handed to the store method, which writes it inside the *same* transaction as the change
   * (see `withMeta`), so a lifecycle change is never committed unrecorded and a record never
   * outlives one that rolled back. The row reaches the store as a plan rather than a value
   * because the app it names is what the change itself returns.
   *
   * The app is named by *both* its slug (what a person reads) and its id: a slug is reusable as
   * soon as its app is archived (ruling P3-R10), so slug alone cannot identify which app a row
   * is about once one has been replaced.
   */
  private entry(companyId: string, actor: DataActor, operation: string, app: AppRecord, details: Record<string, unknown>): AuditEntry {
    return { companyId, actor, operation, table: null, details: { app: app.slug, appId: app.id, ...details } };
  }

  /**
   * The activity-log summariser, after the change and its audit row have committed. Mirrors
   * `DataService.notify`: a subscriber's failure must never surface as a failed call — the
   * caller could retry and create a second app or a duplicate version.
   */
  private async notify(companyId: string, actor: DataActor, operation: string, app: AppRecord, summary: string): Promise<void> {
    if (!this.onMutation) return;
    // The activity entry points at the app, not at a table — this service changes no rows.
    const event: MutationEvent = { companyId, actor, operation, table: null, entityId: app.id, summary };
    try {
      await this.onMutation(event);
    } catch (error) {
      if (this.onMutationError) this.onMutationError(error, event);
    }
  }
}
