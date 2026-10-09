import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { withMeta, type AuditEntry } from "../data/audit.js";
import { DataError } from "../data/errors.js";
import { levelAllows, type AccessLevel, type DataActor } from "../data/permissions.js";
import { ensureCompany, schemaNameFor } from "../db/company-scope.js";
import { canonical } from "../decisions/contract.js";
import type { GuardAgentAction, GuardContext } from "../decisions/guardrail.js";
import { isManagerRole } from "../groups/levels.js";
import { SECRET_CACHE_MS, type SecretCache } from "../secrets/cache.js";
import { CONNECTION_NAME_RE, parseConnections, type Connection, type ConnectionAuth, type ConnectionMethods, type ConnectionProblem } from "./config.js";
import { getConnectionGrant, listConnectionGrants, setConnectionGrant, type ConnectionAccess, type ConnectionGrant } from "./grants.js";
import { buildHeaders, buildUrl, parseCallInput, pathWithoutQuery, shapeResponse, type ParsedCall } from "./request.js";

/**
 * Every call to an external API goes through here (spec §4): an app's viewer, an agent with a grant,
 * or a person. The call runs as its caller, the secret is added only to the outgoing request, and
 * every call after the connection is found is audited without its contents.
 */
export type CallVia = { kind: "app"; slug: string; version: number; declared: "read" | "read-write" } | { kind: "direct" };

export interface ConnectionActivity {
  companyId: string;
  actor: DataActor;
  summary: string;
  /** The connection's name, for the activity entry it is filed under. */
  connection: string;
}

export interface ConnectionServiceDeps {
  pool: Pool;
  getConfig(companyId: string): Promise<Record<string, unknown>>;
  secrets: SecretCache;
  fetch(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<Response>;
  levelFor(companyId: string, actor: DataActor): Promise<AccessLevel>;
  resolveUserRole(companyId: string, userId: string, fresh: boolean): Promise<string | null>;
  guardAgentAction?: GuardAgentAction;
  onActivity?(event: ConnectionActivity): Promise<void>;
  now?(): number;
}

export interface ConnectionSummary {
  name: string;
  baseUrl: string;
  auth: ConnectionAuth;
  methods: ConnectionMethods;
  available: boolean;
  access: ConnectionAccess;
}

export interface ConnectionStatus {
  connections: Array<{ name: string; baseUrl: string; auth: ConnectionAuth; methods: ConnectionMethods; available: boolean; problem: string | null }>;
  problems: ConnectionProblem[];
}

export interface ConnectionResponse { status: number; headers: Record<string, string>; body: string }

const MAX_AGENT_ID_CHARS = 200;
const forbidden = (message: string): DataError => new DataError("forbidden", message);

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Where a call came from, as the audit row names it. */
function viaText(via: CallVia, actor: DataActor): string {
  if (via.kind === "app") return `app@${via.slug}@${via.version}`;
  return actor.kind === "agent" ? "agent" : "person";
}

/**
 * The core's fetch failures, mapped without repeating them: the core's text can carry the URL (and
 * so the query) and the SDK's can carry anything, so the caller only ever hears fixed text.
 * - The SDK cannot build a Response for a null-body status (204, 205, 304) and throws instead; the
 *   remote service did answer, so that is an empty answer with that status.
 * - The core aborts after 30 s ("The operation was aborted"), the SDK's own RPC gives up after 30 s
 *   ('Worker→host call "http.fetch" timed out after 30000ms'), and the core's DNS lookup has its own
 *   deadline ("DNS lookup timed out ..."): all `timeout`.
 * - Anything else (DNS failure, a private or reserved address refused, a reset) is
 *   `provider_unavailable`.
 */
function mapFetchFailure(error: unknown, name: string): { status: number } | DataError {
  const message = error instanceof Error ? error.message : String(error);
  const nullBody = /Invalid response status code (\d{3})/.exec(message);
  if (nullBody) return { status: Number(nullBody[1]) };
  const errorName = error instanceof Error ? error.name : "";
  if (errorName === "AbortError" || errorName === "TimeoutError" || /timed out|ETIMEDOUT|operation was aborted/i.test(message)) {
    return new DataError("timeout", `the connection '${name}' did not answer within 30 s`);
  }
  return new DataError("provider_unavailable", `the connection '${name}' could not be reached; try again later`);
}

export class ConnectionService {
  /**
   * Ruling R3: a secret that failed to resolve is not asked for again by availability checks
   * (`list`, `status`) until this time, per company and connection. The secret cache keeps only
   * values, never failures, and the core allows 30 lookups a minute per company.
   */
  private readonly unavailableUntil = new Map<string, number>();

  constructor(private readonly deps: ConnectionServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async connections(companyId: string): Promise<{ connections: Connection[]; problems: ConnectionProblem[] }> {
    return parseConnections((await this.deps.getConfig(companyId)) ?? {});
  }

  private secret(companyId: string, connection: Connection): Promise<string> {
    return this.deps.secrets.get(companyId, `connection:${connection.name}`, connection.secretRef, connection.configPath);
  }

  private availabilityKey(companyId: string, name: string): string {
    return `${companyId}\u0000${name}`;
  }

  /** Never throws. One secret lookup per connection per minute at most, whether it works or not. */
  private async available(companyId: string, connection: Connection): Promise<boolean> {
    const key = this.availabilityKey(companyId, connection.name);
    const until = this.unavailableUntil.get(key);
    if (until !== undefined && until > this.now()) return false;
    try {
      const value = await this.secret(companyId, connection);
      if (typeof value !== "string" || value === "") throw new Error("empty");
      this.unavailableUntil.delete(key);
      return true;
    } catch {
      this.unavailableUntil.set(key, this.now() + SECRET_CACHE_MS);
      return false;
    }
  }

  invalidate(companyId?: string | null): void {
    if (companyId) {
      const prefix = `${companyId}\u0000`;
      for (const key of [...this.unavailableUntil.keys()]) if (key.startsWith(prefix)) this.unavailableUntil.delete(key);
    } else {
      this.unavailableUntil.clear();
    }
  }

  // ---- discovery ------------------------------------------------------------------------------

  async list(companyId: string, actor: DataActor): Promise<ConnectionSummary[]> {
    schemaNameFor(companyId);
    const accessFor = await this.accessResolver(companyId, actor);
    const { connections } = await this.connections(companyId);
    return Promise.all(connections.map(async (connection) => ({
      name: connection.name,
      baseUrl: connection.baseUrl,
      auth: connection.auth,
      methods: connection.methods,
      available: await this.available(companyId, connection),
      access: accessFor(connection),
    })));
  }

  /** The caller's own access per connection: agents by grant, people by level (or role). */
  private async accessResolver(companyId: string, actor: DataActor): Promise<(connection: Connection) => ConnectionAccess> {
    if (actor.kind === "agent" && actor.id) {
      const agentId = actor.id;
      const grants = new Map((await listConnectionGrants(this.deps.pool, companyId)).filter((g) => g.agentId === agentId).map((g) => [g.connection, g.access]));
      return (connection) => {
        const grant = grants.get(connection.name) ?? "none";
        return grant === "read-write" && connection.methods !== "read-write" ? "read" : grant;
      };
    }
    if (actor.kind === "user" && actor.id) {
      const level = await this.deps.levelFor(companyId, actor);
      const manager = levelAllows(level, "write") ? false : isManagerRole(await this.deps.resolveUserRole(companyId, actor.id, false));
      if (!manager && !levelAllows(level, "read")) throw forbidden("listing connections requires read access to company data");
      const canWrite = manager || levelAllows(level, "write");
      return (connection) => (canWrite && connection.methods === "read-write" ? "read-write" : "read");
    }
    throw forbidden("only people and agents can list connections");
  }

  /** For the admin page; the caller checks who may see it. */
  async status(companyId: string): Promise<ConnectionStatus> {
    schemaNameFor(companyId);
    const { connections, problems } = await this.connections(companyId);
    const rows = await Promise.all(connections.map(async (connection) => {
      const available = await this.available(companyId, connection);
      return { name: connection.name, baseUrl: connection.baseUrl, auth: connection.auth, methods: connection.methods, available, problem: available ? null : "secret doesn't resolve" };
    }));
    return { connections: rows, problems };
  }

  // ---- calls ----------------------------------------------------------------------------------

  async call(companyId: string, actor: DataActor, name: string, raw: unknown, via: CallVia, guard?: GuardContext): Promise<ConnectionResponse> {
    schemaNameFor(companyId);
    const call = parseCallInput(raw);
    if (typeof name !== "string" || !CONNECTION_NAME_RE.test(name)) throw new DataError("invalid", "the connection name must be lower-case letters, digits, - and _, starting with a letter");
    const connection = (await this.connections(companyId)).connections.find((c) => c.name === name);
    if (!connection) {
      throw new DataError("disabled", via.kind === "app"
        ? `This app's connection '${name}' isn't set up. Ask a company admin.`
        : `The connection '${name}' isn't set up. Ask a company admin to set it up.`);
    }

    // From here on every outcome is audited: a refusal as much as a completed call.
    const path = pathWithoutQuery(call.path);
    const details = { connection: name, method: call.method, path };
    const viaLabel = viaText(via, actor);
    let ms: number | null = null;
    let status: number | null = null;
    let bytes: number | null = null;
    let response: ConnectionResponse;
    try {
      await this.authorise(companyId, actor, connection, call, via);
      const url = buildUrl(connection, call.path, call.query);
      if (actor.kind === "agent" && call.method !== "GET" && this.deps.guardAgentAction) {
        // Only now: the path on the card has been validated, and the caller may make this call.
        await this.deps.guardAgentAction({
          operation: "connection_write",
          companyId,
          actor,
          guard,
          connection: name,
          method: call.method,
          path,
          params: { connection: name, method: call.method, path: call.path, queryHash: sha256(JSON.stringify(canonical(call.query))), bodyHash: sha256(call.body ?? "") },
        });
      }
      const secret = await this.secretForCall(companyId, connection);
      const headers = buildHeaders(connection, call, secret);
      const started = this.now();
      let bodyText: string;
      let responseHeaders: Headers | Record<string, string>;
      try {
        const res = await this.deps.fetch(url, call.body === null ? { method: call.method, headers } : { method: call.method, headers, body: call.body });
        status = res.status;
        responseHeaders = res.headers;
        bodyText = await res.text();
        ms = this.now() - started;
      } catch (error) {
        ms = this.now() - started;
        const mapped = mapFetchFailure(error, name);
        if (mapped instanceof DataError) throw mapped;
        status = mapped.status;
        responseHeaders = {};
        bodyText = "";
      }
      bytes = Buffer.byteLength(bodyText, "utf8");
      response = shapeResponse({ status, headers: responseHeaders, bodyText });
    } catch (error) {
      const outcome = error instanceof DataError ? error.code : "error";
      await this.audit(companyId, actor, { ...details, status, ms, bytes, via: viaLabel, outcome }).catch(() => {});
      throw error;
    }

    // The response is released only once its audit row is written.
    await this.audit(companyId, actor, { ...details, status: response.status, ms, bytes, via: viaLabel });
    if (actor.kind === "agent" && this.deps.onActivity) {
      // App calls are too frequent for the activity log; people's calls are in the audit.
      await this.deps.onActivity({ companyId, actor, summary: `connection ${name}: ${call.method} ${path} → ${response.status}`, connection: name }).catch(() => {});
    }
    return response;
  }

  private async authorise(companyId: string, actor: DataActor, connection: Connection, call: ParsedCall, via: CallVia): Promise<void> {
    const write = call.method !== "GET";
    const op = write ? "write" : "read";
    if (write && connection.methods !== "read-write") throw forbidden(`the connection '${connection.name}' allows reads (GET) only`);
    if (!actor.id || (actor.kind !== "user" && actor.kind !== "agent")) throw forbidden("only people and agents can call a connection");

    if (via.kind === "app") {
      // The app narrows its viewer: the viewer's own level and the app's declaration both apply.
      if (actor.kind !== "user") throw forbidden("an app calls a connection as the person viewing it");
      if (!levelAllows(await this.deps.levelFor(companyId, actor), op)) throw forbidden(`calling '${connection.name}' with ${call.method} requires ${op} access to company data`);
      if (write && via.declared !== "read-write") throw forbidden(`this app declared read access only to the connection '${connection.name}'`);
      return;
    }

    if (actor.kind === "agent") {
      const grant = await getConnectionGrant(this.deps.pool, companyId, actor.id, connection.name);
      if (grant === "none") throw forbidden(`this agent has no access to the connection '${connection.name}'; ask a company owner or admin to grant it on the Data access page`);
      if (write && grant !== "read-write") throw forbidden(`this agent may only read (GET) from the connection '${connection.name}'`);
      return;
    }

    if (isManagerRole(await this.deps.resolveUserRole(companyId, actor.id, false))) return;
    if (!levelAllows(await this.deps.levelFor(companyId, actor), op)) throw forbidden(`calling '${connection.name}' with ${call.method} requires ${op} access to company data`);
  }

  /** `call` always asks (the cache permitting), even while availability checks are backing off. */
  private async secretForCall(companyId: string, connection: Connection): Promise<string> {
    const key = this.availabilityKey(companyId, connection.name);
    try {
      const value = await this.secret(companyId, connection);
      if (typeof value !== "string" || value === "") throw new Error("empty");
      this.unavailableUntil.delete(key);
      return value;
    } catch {
      // The core's message is never repeated: it is not the caller's to read.
      this.unavailableUntil.set(key, this.now() + SECRET_CACHE_MS);
      throw new DataError("disabled", `the connection '${connection.name}' secret could not be read; check the secret picked in the plugin settings`);
    }
  }

  /** A meta transaction that only writes the audit row: there is no change to commit with it. */
  private async audit(companyId: string, actor: DataActor, details: Record<string, unknown>): Promise<void> {
    const entry: AuditEntry = { companyId, actor, operation: "connection_call", details };
    await withMeta(this.deps.pool, async () => undefined, () => entry);
  }

  // ---- grants (owners and admins, by role read fresh) ----------------------------------------

  private async assertAdmin(companyId: string, actor: DataActor): Promise<void> {
    schemaNameFor(companyId);
    if (actor.kind !== "user" || !actor.id) throw forbidden("only company owners and admins manage connection access");
    if (!isManagerRole(await this.deps.resolveUserRole(companyId, actor.id, true))) throw forbidden("only company owners and admins manage connection access");
  }

  async listGrants(companyId: string, actor: DataActor): Promise<ConnectionGrant[]> {
    await this.assertAdmin(companyId, actor);
    return listConnectionGrants(this.deps.pool, companyId);
  }

  async setGrant(companyId: string, actor: DataActor, agentId: string, connection: string, access: ConnectionAccess): Promise<void> {
    await this.assertAdmin(companyId, actor);
    if (typeof agentId !== "string" || agentId.trim() === "" || agentId.length > MAX_AGENT_ID_CHARS) throw new DataError("invalid", "agentId is required");
    if (typeof connection !== "string" || !CONNECTION_NAME_RE.test(connection)) throw new DataError("invalid", "the connection name must be lower-case letters, digits, - and _, starting with a letter");
    if (access !== "none" && access !== "read" && access !== "read-write") throw new DataError("invalid", "connection access must be one of none, read, read-write");
    // The grants table references the company row.
    await ensureCompany(this.deps.pool, companyId);
    await withMeta(
      this.deps.pool,
      (client) => setConnectionGrant(client, companyId, agentId, connection, access, actor.id),
      () => ({ companyId, actor, operation: "set_connection_grant", details: { agentId, connection, access } }),
    );
    if (this.deps.onActivity) {
      await this.deps.onActivity({ companyId, actor, summary: `set agent ${agentId} access to connection ${connection} to ${access}`, connection }).catch(() => {});
    }
  }
}
