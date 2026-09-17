import type { Pool } from "pg";
import { ensureCompany, schemaNameFor, type CompanyScope } from "../db/company-scope.js";
import { withMeta, type AuditEntry } from "./audit.js";
import { DataError } from "./errors.js";
import type { QuerySpec } from "./filter.js";
import { getAgentLevel, getCompanySettings, listAgentGrants, setAgentGrant, setCompanySettings, type AgentGrant, type CompanySettings } from "./grants.js";
import { assertLevel, roleToLevel, type AccessLevel, type DataActor, type Operation } from "./permissions.js";
import { RecordsService, type Row, type RowTarget } from "./records-service.js";
import { SchemaService, type CreateTableInput, type TableInfo, type UpdateFieldPatch } from "./schema-service.js";

/**
 * Ruling P4-R21: the app a row mutation was made *through*, recorded in the audit row's details.
 *
 * It is a parameter and never derived from the actor: a running app's data calls go to this
 * service under the *viewer's own* actor (that is what keeps an app from widening what its
 * viewer may do), so "who changed this" and "what they changed it through" are two different
 * facts and the second cannot be inferred from the first. Only a trusted internal caller —
 * `AppService.runtimeData`, from the published version it just resolved — ever passes it; it is
 * never taken from a request body, a tool call's parameters, or an app's own message.
 */
export interface ViaApp {
  app: string;
  version: number;
}

export interface MutationEvent {
  companyId: string;
  actor: DataActor;
  operation: string;
  table: string | null;
  /**
   * What the event is about, when that is not a table: the app's id for an app lifecycle change.
   * A data mutation names no entity of its own and leaves this unset — the plugin's summariser
   * then files the event under its table, as it always has.
   */
  entityId?: string | null;
  summary: string;
}

export interface DataServiceDeps {
  pool: Pool;
  /**
   * The caller's company role. `fresh` (ruling P4-R13) asks for a lookup that ignores any cache:
   * it is true for schema changes and for grant/settings changes, false for reads and row writes.
   */
  resolveUserRole: (companyId: string, userId: string, fresh: boolean) => Promise<string | null>;
  onMutation?: (event: MutationEvent) => Promise<void>;
  onMutationError?: (error: unknown, event: MutationEvent) => void;
}

const TRASH_RETENTION_MS = 30 * 86_400_000;

/**
 * The trusted system actor for plugin-internal jobs (currently `purgeTrash`).
 * `{ kind: "system" }` must only ever be constructed this way, from inside
 * this plugin's own trusted code — never from a request body, a tool call's
 * parameters, model output, or any other external input. See the invariant
 * documented on `levelFor` below.
 */
export function systemActor(): DataActor {
  return { kind: "system", id: null, runId: null };
}

export class DataService {
  private readonly schema: SchemaService;
  private readonly records: RecordsService;
  private readonly pool: Pool;
  private readonly resolveUserRole: DataServiceDeps["resolveUserRole"];
  private readonly onMutation: DataServiceDeps["onMutation"];
  private readonly onMutationError: DataServiceDeps["onMutationError"];

  constructor(deps: DataServiceDeps) {
    this.pool = deps.pool;
    this.resolveUserRole = deps.resolveUserRole;
    this.onMutation = deps.onMutation;
    this.onMutationError = deps.onMutationError;
    this.schema = new SchemaService(deps.pool);
    this.records = new RecordsService(deps.pool, this.schema);
  }

  /**
   * Provisions (or returns the cached) schema/role for `companyId`. This
   * provisions only and grants nothing: it performs no level check on any
   * actor, and the `CompanyScope` it returns carries no authorization by
   * itself. It is public only because the plugin's `setup_company` wiring
   * needs to provision a company ahead of any actor-scoped call. Reading or
   * writing company data must go through the actor-checked methods below
   * (which call `authorize`/`authorizeAdmin`), never by taking this scope
   * and driving `SchemaService`/`RecordsService` directly.
   */
  scope(companyId: string): Promise<CompanyScope> {
    return ensureCompany(this.pool, companyId);
  }

  /**
   * Invariant: `actor.kind === "system"` grants unconditional "schema"
   * access below, before `id` (or anything else about the actor) is even
   * looked at. A `DataActor` with `kind: "system"` must therefore only ever
   * be constructed inside this plugin via `systemActor()` above — never
   * from a request body, a tool call's parameters, model output, or any
   * other external input. Every boundary that builds a `DataActor` from
   * outside this plugin (API routes, tool handlers, UI actions) must narrow
   * the actor's `kind` to "user" | "agent" before it reaches this method or
   * any other `DataService` method.
   */
  async levelFor(companyId: string, actor: DataActor, opts: { fresh?: boolean } = {}): Promise<AccessLevel> {
    // Ruling P4-R17: resolving a level provisions nothing. Grants and settings live in
    // kyoube_meta, which the login role reads without a company schema existing (an absent row
    // reads as "none"), and company roles come from the host — so anyone at all could otherwise
    // make this create a schema and a Postgres role for any uuid they cared to name. The id is
    // still validated here, before it reaches any query: schemaNameFor throws for a non-uuid.
    schemaNameFor(companyId);
    if (actor.kind === "system") return "schema";
    if (!actor.id) return "none";
    // Agent grants are read from kyoube_meta on every call, so they are never stale.
    if (actor.kind === "user") return roleToLevel(await this.resolveUserRole(companyId, actor.id, opts.fresh === true));
    return getAgentLevel(this.pool, companyId, actor.id);
  }

  async myAccess(companyId: string, actor: DataActor): Promise<{ level: AccessLevel; actorKind: string; hint: string }> {
    const level = await this.levelFor(companyId, actor);
    const hint = level === "schema"
      ? "You can read, write, and change the schema."
      : `You have ${level} access. To get more, ask a company admin to raise your level under Company Settings → Data access.`;
    return { level, actorKind: actor.kind, hint };
  }

  // ---- schema -----------------------------------------------------------

  async listTables(companyId: string, actor: DataActor): Promise<TableInfo[]> {
    const scope = await this.authorize(companyId, actor, "read", "list tables");
    return this.schema.listTables(scope);
  }

  async describeTable(companyId: string, actor: DataActor, table: string): Promise<TableInfo> {
    const scope = await this.authorize(companyId, actor, "read", "describe a table");
    return this.schema.getTable(scope, table);
  }

  async createTable(companyId: string, actor: DataActor, input: CreateTableInput): Promise<TableInfo> {
    const scope = await this.authorize(companyId, actor, "schema", "create a table");
    const table = await this.schema.createTable(scope, input, { kind: actor.kind, id: actor.id },
      (created) => this.entry(companyId, actor, "create_table", created.name, { fields: created.fields }));
    await this.notify(companyId, actor, "create_table", table.name, `created table ${table.name}`);
    return table;
  }

  async addField(companyId: string, actor: DataActor, table: string, field: unknown): Promise<TableInfo> {
    const scope = await this.authorize(companyId, actor, "schema", "add a field");
    const info = await this.schema.addField(scope, table, field,
      (name) => this.entry(companyId, actor, "add_field", name, { field }));
    await this.notify(companyId, actor, "add_field", info.name, `added a field to ${info.name}`);
    return info;
  }

  async updateField(companyId: string, actor: DataActor, table: string, field: string, patch: UpdateFieldPatch): Promise<TableInfo> {
    const scope = await this.authorize(companyId, actor, "schema", "update a field");
    const info = await this.schema.updateField(scope, table, field, patch,
      (name) => this.entry(companyId, actor, "update_field", name, { field, patch }));
    await this.notify(companyId, actor, "update_field", info.name, `updated field ${field} on ${info.name}`);
    return info;
  }

  async removeField(companyId: string, actor: DataActor, table: string, field: string): Promise<TableInfo> {
    const scope = await this.authorize(companyId, actor, "schema", "remove a field");
    const hard = (await getCompanySettings(this.pool, companyId)).hardDelete;
    const info = await this.schema.removeField(scope, table, field, hard,
      (name) => this.entry(companyId, actor, "remove_field", name, { field, hard }));
    await this.notify(companyId, actor, "remove_field", info.name, `removed field ${field} from ${info.name}`);
    return info;
  }

  async dropTable(companyId: string, actor: DataActor, table: string): Promise<{ ok: true }> {
    const scope = await this.authorize(companyId, actor, "schema", "drop a table");
    const hard = (await getCompanySettings(this.pool, companyId)).hardDelete;
    await this.schema.dropTable(scope, table, hard,
      (name) => this.entry(companyId, actor, "drop_table", name, { hard }));
    await this.notify(companyId, actor, "drop_table", table, `dropped table ${table}${hard ? "" : " (recoverable for 30 days)"}`);
    return { ok: true };
  }

  async renameTable(companyId: string, actor: DataActor, table: string, newName: string): Promise<TableInfo> {
    const scope = await this.authorize(companyId, actor, "schema", "rename a table");
    const info = await this.schema.renameTable(scope, table, newName,
      (name) => this.entry(companyId, actor, "rename_table", name, { from: table }));
    await this.notify(companyId, actor, "rename_table", info.name, `renamed table ${table} to ${info.name}`);
    return info;
  }

  async createIndex(companyId: string, actor: DataActor, table: string, fields: string[], unique: boolean): Promise<{ name: string }> {
    const scope = await this.authorize(companyId, actor, "schema", "create an index");
    const result = await this.schema.createIndex(scope, table, fields, unique,
      (name) => this.entry(companyId, actor, "create_index", name, { fields, unique }));
    await this.notify(companyId, actor, "create_index", table, `created index ${result.name}`);
    return result;
  }

  // ---- records ----------------------------------------------------------

  // `via` (ruling P4-R21) marks a row mutation an app made on its viewer's behalf. Only the
  // three methods an app's runtime can reach take it; nothing else in the runtime writes rows.
  async insert(companyId: string, actor: DataActor, table: string, rows: unknown[], via?: ViaApp): Promise<Row[]> {
    const scope = await this.authorize(companyId, actor, "write", "insert rows");
    const inserted = await this.records.insert(scope, table, rows, { kind: actor.kind, id: actor.id },
      (created) => this.entry(companyId, actor, "insert", table, { count: created.length, ids: created.map((row) => row.id) }, via));
    await this.notify(companyId, actor, "insert", table, `inserted ${inserted.length} row(s) into ${table}`);
    return inserted;
  }

  async update(companyId: string, actor: DataActor, table: string, target: RowTarget, patch: Row, via?: ViaApp): Promise<{ affected: number; rows: Row[] }> {
    const scope = await this.authorize(companyId, actor, "write", "update rows");
    const result = await this.records.update(scope, table, target, patch,
      (done) => this.entry(companyId, actor, "update", table, { affected: done.affected, fields: Object.keys(patch) }, via));
    await this.notify(companyId, actor, "update", table, `updated ${result.affected} row(s) in ${table}`);
    return result;
  }

  async delete(companyId: string, actor: DataActor, table: string, target: RowTarget, via?: ViaApp): Promise<{ affected: number }> {
    const scope = await this.authorize(companyId, actor, "write", "delete rows");
    const result = await this.records.delete(scope, table, target,
      (done) => this.entry(companyId, actor, "delete", table, { affected: done.affected }, via));
    await this.notify(companyId, actor, "delete", table, `deleted ${result.affected} row(s) from ${table}`);
    return result;
  }

  async get(companyId: string, actor: DataActor, table: string, id: string): Promise<Row | null> {
    const scope = await this.authorize(companyId, actor, "read", "read a row");
    return this.records.get(scope, table, id);
  }

  async query(companyId: string, actor: DataActor, table: string, spec: QuerySpec): Promise<{ rows: Row[]; limit: number; offset: number }> {
    const scope = await this.authorize(companyId, actor, "read", "query rows");
    return this.records.query(scope, table, spec);
  }

  async count(companyId: string, actor: DataActor, table: string, where?: unknown): Promise<number> {
    const scope = await this.authorize(companyId, actor, "read", "count rows");
    return this.records.count(scope, table, where);
  }

  async sqlSelect(companyId: string, actor: DataActor, sql: string, params: unknown[] = []): Promise<{ columns: string[]; rows: Row[]; truncated: boolean }> {
    const scope = await this.authorize(companyId, actor, "read", "run SQL");
    return this.records.sqlSelect(scope, sql, params);
  }

  // ---- administration ---------------------------------------------------

  async listAgentGrants(companyId: string, actor: DataActor): Promise<AgentGrant[]> {
    await this.authorizeAdmin(companyId, actor);
    return listAgentGrants(this.pool, companyId);
  }

  async setAgentGrant(companyId: string, actor: DataActor, agentId: string, level: AccessLevel): Promise<AgentGrant> {
    await this.authorizeAdmin(companyId, actor);
    if (!agentId) throw new DataError("invalid", "agentId is required");
    const grant = await withMeta(
      this.pool,
      (client) => setAgentGrant(client, companyId, agentId, level, actor.id),
      () => this.entry(companyId, actor, "set_agent_grant", null, { agentId, level }),
    );
    await this.notify(companyId, actor, "set_agent_grant", null, `set agent ${agentId} data access to ${level}`);
    return grant;
  }

  async getSettings(companyId: string, actor: DataActor): Promise<CompanySettings> {
    await this.authorizeAdmin(companyId, actor);
    return getCompanySettings(this.pool, companyId);
  }

  async setSettings(companyId: string, actor: DataActor, patch: Partial<CompanySettings>): Promise<CompanySettings> {
    await this.authorizeAdmin(companyId, actor);
    const settings = await withMeta(
      this.pool,
      (client) => setCompanySettings(client, companyId, patch),
      (saved) => this.entry(companyId, actor, "set_settings", null, { ...saved }),
    );
    await this.notify(companyId, actor, "set_settings", null, `updated data settings`);
    return settings;
  }

  async purgeTrash(companyId: string): Promise<{ droppedTables: string[]; droppedColumns: string[] }> {
    const scope = await this.scope(companyId);
    const actor = systemActor();
    const result = await this.schema.purgeTrash(scope, TRASH_RETENTION_MS, Date.now(),
      (purged) => (purged.droppedTables.length + purged.droppedColumns.length > 0 ? this.entry(companyId, actor, "purge_trash", null, purged) : null));
    if (result.droppedTables.length + result.droppedColumns.length > 0) {
      await this.notify(companyId, actor, "purge_trash", null, `purged ${result.droppedTables.length} table(s) and ${result.droppedColumns.length} column(s)`);
    }
    return result;
  }

  // ---- internals --------------------------------------------------------

  /**
   * Ruling P4-R13: a schema change takes a *fresh* role lookup — those are the operations a
   * just-removed or just-demoted admin could do the most damage with, and they are rare enough
   * that one extra membership read each costs nothing. Reads and row writes keep the 30 s cache.
   */
  private async authorize(companyId: string, actor: DataActor, op: Operation, what: string): Promise<CompanyScope> {
    // Ruling P4-R17: the level decides first, and only an allowed caller gets as far as
    // provisioning the company's schema and role.
    assertLevel(await this.levelFor(companyId, actor, { fresh: op === "schema" }), op, what);
    return this.scope(companyId);
  }

  /**
   * Grants and settings decide who may do anything at all here, so they are always fresh
   * (P4-R13) — and, like `authorize`, they provision only once the caller is allowed (P4-R17).
   * The company row has to exist before either table can reference it.
   */
  private async authorizeAdmin(companyId: string, actor: DataActor): Promise<void> {
    if (actor.kind !== "user") throw new DataError("forbidden", "only company admins manage data access");
    assertLevel(await this.levelFor(companyId, actor, { fresh: true }), "schema", "managing data access");
    await this.scope(companyId);
  }

  /**
   * Ruling P4-R12: the audit row for one mutation. It is never written here — it is handed to
   * the service method, which passes it into the *same* transaction as the change (see
   * `withCompany`'s `audit` option), so a change is never committed unrecorded and a record
   * never outlives a rolled-back change.
   */
  private entry(companyId: string, actor: DataActor, operation: string, table: string | null, details: Record<string, unknown>, via?: ViaApp): AuditEntry {
    // Only the two known fields are copied, so a caller's object cannot widen what a details
    // blob carries; the row still names the viewer as the actor (ruling P4-R21).
    const withVia = via ? { ...details, via: { app: via.app, version: via.version } } : details;
    return { companyId, actor, operation, table, details: withVia };
  }

  /**
   * The activity-log summariser, after the mutation and its audit row have committed. A
   * subscriber's failure must never surface as a failed write (the caller could retry and
   * duplicate it), so it is caught here and handed to onMutationError instead of being rethrown.
   */
  private async notify(companyId: string, actor: DataActor, operation: string, table: string | null, summary: string): Promise<void> {
    if (!this.onMutation) return;
    const event: MutationEvent = { companyId, actor, operation, table, summary };
    try {
      await this.onMutation(event);
    } catch (error) {
      if (this.onMutationError) this.onMutationError(error, event);
    }
  }
}
