import type { Pool } from "pg";
import type { AuditEntry } from "../data/audit.js";
import { DataError } from "../data/errors.js";
import type { QuerySpec } from "../data/filter.js";
import { assertLevel, levelAllows, type AccessLevel, type DataActor, type Operation } from "../data/permissions.js";
import type { Row, RowTarget } from "../data/records-service.js";
import type { DataService, MutationEvent } from "../data/service.js";
import { schemaNameFor } from "../db/company-scope.js";
import { assertAppSource, validateAppManifest } from "./manifest.js";
import { AppStore, type AppRecord, type AppVersion } from "./store.js";

/** What a running app is told about itself, its viewer, and the tables it may touch. */
export interface AppContext {
  companyId: string;
  viewer: { id: string | null; name: string; level: AccessLevel };
  app: { slug: string; name: string; version: number };
  tables: string[];
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
  onMutation?: (event: MutationEvent) => Promise<void>;
  onMutationError?: (error: unknown, event: MutationEvent) => void;
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
  private readonly store: AppStore;
  private readonly data: DataService;
  private readonly onMutation: AppServiceDeps["onMutation"];
  private readonly onMutationError: AppServiceDeps["onMutationError"];

  constructor(deps: AppServiceDeps) {
    this.data = deps.data;
    this.store = new AppStore(deps.pool);
    this.onMutation = deps.onMutation;
    this.onMutationError = deps.onMutationError;
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
    const saved = await this.store.addVersion(companyId, slug, manifest, source, { kind: actor.kind, id: actor.id }, notes,
      (result) => this.entry(companyId, actor, "app_update", result.app, { version: result.version.version }));
    await this.notify(companyId, actor, "app_update", saved.app, `saved app ${slug} version ${saved.version.version} (draft)`);
    return saved.version;
  }

  // Ruling P4-R13: publish, rollback and archive change what every viewer of this company runs,
  // so each takes a fresh role lookup rather than up to 30 s of cached membership.
  async publish(companyId: string, actor: DataActor, slug: string, version?: number): Promise<AppRecord> {
    await this.authorize(companyId, actor, "schema", "publish an app", { fresh: true });
    const published = await this.makeCurrent(companyId, actor, slug, version ?? "latest", "app_publish");
    await this.notify(companyId, actor, "app_publish", published.app, `published app ${slug} version ${published.version}`);
    return published.app;
  }

  async rollback(companyId: string, actor: DataActor, slug: string, version: number): Promise<AppRecord> {
    await this.authorize(companyId, actor, "schema", "roll back an app", { fresh: true });
    const rolled = await this.makeCurrent(companyId, actor, slug, version, "app_rollback");
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
    return {
      context: {
        companyId,
        viewer: { id: actor.id, name: viewerName, level },
        app: { slug: app.slug, name: app.name, version: version.version },
        tables: version.manifest.tables.map((table) => table.name),
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
  private async makeCurrent(companyId: string, actor: DataActor, slug: string, version: number | "latest", operation: string): Promise<{ app: AppRecord; version: number }> {
    const target = await this.store.getVersion(companyId, slug, version);
    if (!target) throw new DataError("not_found", `app "${slug}" has no version ${version}`);
    for (const table of target.manifest.tables) await this.data.describeTable(companyId, actor, table.name);
    const app = await this.store.setCurrent(companyId, slug, target.version,
      (published) => this.entry(companyId, actor, operation, published, { version: target.version }));
    return { app, version: target.version };
  }

  /**
   * Resolves the published app a viewer may open. Archived apps are already
   * invisible to the store's by-slug lookups (ruling P3-R10), and a draft, an
   * archived app, and a slug that never existed all get the same "not
   * published" answer, so read access cannot be used to probe for drafts.
   */
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
