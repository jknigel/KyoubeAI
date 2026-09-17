import type { PluginApiRequestInput, PluginApiResponse, PluginApiRouteDeclaration } from "@paperclipai/plugin-sdk";
import { z } from "zod";
import { DataError } from "./data/errors.js";
import { FIELD_KINDS } from "./data/field-kinds.js";
import type { DataActor } from "./data/permissions.js";
import type { DataService } from "./data/service.js";

type Method = "GET" | "POST";

function route(routeKey: string, method: Method, path: string, auth: PluginApiRouteDeclaration["auth"] = "board-or-agent"): PluginApiRouteDeclaration {
  return {
    routeKey,
    method,
    path,
    auth,
    capability: "api.routes.register",
    companyResolution: method === "GET" ? { from: "query", key: "companyId" } : { from: "body", key: "companyId" },
  };
}

export const API_ROUTES: PluginApiRouteDeclaration[] = [
  // Installs the two managed skills into the body's company. Board-only: it is
  // how `kyoube ensure-plugins` reaches every company at each container start.
  // The worker cannot do this from its own start-up code — a host call made
  // outside a host-issued invocation carries no company scope, and the host
  // refuses `skills.managed.reconcile` without one — but an API request
  // resolved to a company is such an invocation. Answered in plugin.ts.
  route("skills.install", "POST", "/skills/install", "board"),
  route("access.me", "GET", "/access/me"),
  route("tables.list", "GET", "/tables"),
  route("tables.create", "POST", "/tables"),
  route("tables.get", "GET", "/tables/:table"),
  route("tables.rename", "POST", "/tables/:table/rename"),
  route("tables.drop", "POST", "/tables/:table/drop"),
  route("fields.add", "POST", "/tables/:table/fields"),
  route("fields.update", "POST", "/tables/:table/fields/:field/update"),
  route("fields.remove", "POST", "/tables/:table/fields/:field/remove"),
  route("indexes.create", "POST", "/tables/:table/indexes"),
  route("rows.insert", "POST", "/tables/:table/rows"),
  route("rows.query", "POST", "/tables/:table/rows/query"),
  route("rows.count", "POST", "/tables/:table/rows/count"),
  route("rows.get", "GET", "/tables/:table/rows/:id"),
  route("rows.update", "POST", "/tables/:table/rows/update"),
  route("rows.delete", "POST", "/tables/:table/rows/delete"),
  route("sql.select", "POST", "/sql"),
];

const fieldSpec = z.object({
  name: z.string(),
  kind: z.enum(FIELD_KINDS),
  displayName: z.string().optional(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  options: z.object({ choices: z.array(z.string()).optional(), relationTable: z.string().optional() }).optional(),
});
const bodies = {
  "tables.create": z.object({ name: z.string(), displayName: z.string().optional(), description: z.string().nullable().optional(), fields: z.array(fieldSpec).max(100) }),
  "tables.rename": z.object({ newName: z.string() }),
  "fields.add": z.object({ field: fieldSpec }),
  "fields.update": z.object({ displayName: z.string().optional(), description: z.string().nullable().optional(), required: z.boolean().optional(), choices: z.array(z.string()).optional() }),
  "indexes.create": z.object({ fields: z.array(z.string()).min(1).max(4), unique: z.boolean().optional() }),
  "rows.insert": z.object({ rows: z.array(z.record(z.string(), z.unknown())).min(1).max(500) }),
  "rows.query": z.object({ where: z.unknown().optional(), orderBy: z.array(z.object({ field: z.string(), direction: z.enum(["asc", "desc"]).optional() })).optional(), limit: z.number().int().optional(), offset: z.number().int().optional(), fields: z.array(z.string()).optional() }),
  "rows.count": z.object({ where: z.unknown().optional() }),
  "rows.update": z.object({ ids: z.array(z.string()).max(500).optional(), where: z.unknown().optional(), patch: z.record(z.string(), z.unknown()) }),
  "rows.delete": z.object({ ids: z.array(z.string()).max(500).optional(), where: z.unknown().optional() }),
  "sql.select": z.object({ sql: z.string().min(1).max(20_000), params: z.array(z.unknown()).max(50).optional() }),
} as const;

// Invariant (Ruling P2-R23): the actor is narrowed to "user" | "agent" from
// the host-authenticated `input.actor` ONLY — never from `input.body` (an
// untrusted request payload) — and must never produce `{ kind: "system" }`
// (see `systemActor()` in data/service.ts), which grants unconditional
// schema access and is plugin-internal only.
export function actorFromRequest(input: PluginApiRequestInput): DataActor {
  const actor = input.actor;
  if (actor.actorType === "agent") return { kind: "agent", id: actor.agentId ?? actor.actorId, runId: actor.runId ?? null };
  return { kind: "user", id: actor.userId ?? actor.actorId, runId: null };
}

export function statusForError(error: unknown): number {
  if (error instanceof DataError) {
    return { invalid: 400, forbidden: 403, not_found: 404, conflict: 409, limit: 413 }[error.code];
  }
  return 500;
}

function parseBody<K extends keyof typeof bodies>(key: K, body: unknown): z.infer<(typeof bodies)[K]> {
  const parsed = bodies[key].safeParse(body ?? {});
  if (!parsed.success) throw new DataError("invalid", parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"} ${issue.message}`).join("; "));
  return parsed.data as z.infer<(typeof bodies)[K]>;
}

function param(input: PluginApiRequestInput, name: string): string {
  const value = input.params[name];
  if (!value) throw new DataError("invalid", `${name} is required`);
  return value;
}

export async function handleApiRequest(
  service: DataService,
  input: PluginApiRequestInput,
  log?: (message: string, meta?: Record<string, unknown>) => void,
): Promise<PluginApiResponse> {
  // Ruling P2-R23: refuse before dispatching when the host-supplied actor
  // carries no id (empty or missing `actorId`), rather than letting a hollow
  // actor reach `DataService`.
  if (!input.actor.actorId) {
    return { status: 403, body: { error: "forbidden: unauthenticated", code: "forbidden" } };
  }
  const companyId = input.companyId;
  const actor = actorFromRequest(input);
  try {
    const body = await dispatch(service, input, companyId, actor);
    if (body === undefined) return { status: 404, body: { error: `unknown route ${input.routeKey}`, code: "not_found" } };
    return { status: 200, body };
  } catch (error) {
    const status = statusForError(error);
    if (error instanceof DataError) {
      return { status, body: { error: error.message, code: error.code } };
    }
    // Ruling P2-R24: never echo a raw JS/driver error message to the caller.
    // Log the real error for operators instead (never the request body).
    log?.("api request failed", { routeKey: input.routeKey, companyId, error: String(error) });
    return { status, body: { error: "error: internal error", code: "error" } };
  }
}

async function dispatch(service: DataService, input: PluginApiRequestInput, companyId: string, actor: DataActor): Promise<unknown> {
  switch (input.routeKey) {
    case "access.me": return service.myAccess(companyId, actor);
    case "tables.list": return service.listTables(companyId, actor);
    case "tables.create": { const b = parseBody("tables.create", input.body); return service.createTable(companyId, actor, { name: b.name, displayName: b.displayName, description: b.description, fields: b.fields }); }
    case "tables.get": return service.describeTable(companyId, actor, param(input, "table"));
    case "tables.rename": { const b = parseBody("tables.rename", input.body); return service.renameTable(companyId, actor, param(input, "table"), b.newName); }
    case "tables.drop": return service.dropTable(companyId, actor, param(input, "table"));
    case "fields.add": { const b = parseBody("fields.add", input.body); return service.addField(companyId, actor, param(input, "table"), b.field); }
    case "fields.update": { const b = parseBody("fields.update", input.body); return service.updateField(companyId, actor, param(input, "table"), param(input, "field"), { displayName: b.displayName, description: b.description, required: b.required, choices: b.choices }); }
    case "fields.remove": return service.removeField(companyId, actor, param(input, "table"), param(input, "field"));
    case "indexes.create": { const b = parseBody("indexes.create", input.body); return service.createIndex(companyId, actor, param(input, "table"), b.fields, b.unique ?? false); }
    case "rows.insert": { const b = parseBody("rows.insert", input.body); return service.insert(companyId, actor, param(input, "table"), b.rows); }
    case "rows.query": { const b = parseBody("rows.query", input.body); return service.query(companyId, actor, param(input, "table"), { where: b.where, orderBy: b.orderBy, limit: b.limit, offset: b.offset, fields: b.fields }); }
    case "rows.count": { const b = parseBody("rows.count", input.body); return { count: await service.count(companyId, actor, param(input, "table"), b.where) }; }
    case "rows.get": return service.get(companyId, actor, param(input, "table"), param(input, "id"));
    case "rows.update": { const b = parseBody("rows.update", input.body); return service.update(companyId, actor, param(input, "table"), { ids: b.ids, where: b.where }, b.patch); }
    case "rows.delete": { const b = parseBody("rows.delete", input.body); return service.delete(companyId, actor, param(input, "table"), { ids: b.ids, where: b.where }); }
    case "sql.select": { const b = parseBody("sql.select", input.body); return service.sqlSelect(companyId, actor, b.sql, b.params ?? []); }
    default: return undefined;
  }
}
