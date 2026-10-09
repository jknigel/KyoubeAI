import type { PluginApiRequestInput, PluginApiResponse, PluginApiRouteDeclaration } from "@paperclipai/plugin-sdk";
import { actorFromRequest, errorBody, statusForError } from "../api-routes.js";
import { DataError } from "../data/errors.js";
import { guardFrom } from "../decisions/guardrail.js";
import { CONNECTION_NAME_RE } from "./config.js";
import type { ConnectionService } from "./service.js";

type Method = "GET" | "POST";

function route(routeKey: string, method: Method, path: string): PluginApiRouteDeclaration {
  return {
    routeKey,
    method,
    path,
    auth: "board-or-agent",
    capability: "api.routes.register",
    companyResolution: method === "GET" ? { from: "query", key: "companyId" } : { from: "body", key: "companyId" },
  };
}

export const CONNECTION_API_ROUTES: PluginApiRouteDeclaration[] = [
  route("connections.list", "GET", "/connections"),
  route("connections.call", "POST", "/connections/:name/call"),
];

/**
 * The REST half of connections. Returns `null` for a route that is not
 * `connections.*`, so `plugin.ts` can chain it with the other dispatchers.
 * The actor comes from the host-authenticated request only, never the body.
 */
export async function handleConnectionsApiRequest(
  connections: ConnectionService,
  input: PluginApiRequestInput,
  log?: (message: string, meta?: Record<string, unknown>) => void,
): Promise<PluginApiResponse | null> {
  if (!input.routeKey.startsWith("connections.")) return null;
  if (!input.actor.actorId) {
    return { status: 403, body: { error: "forbidden: unauthenticated", code: "forbidden" } };
  }
  const companyId = input.companyId;
  const actor = actorFromRequest(input);
  try {
    switch (input.routeKey) {
      case "connections.list":
        return { status: 200, body: { connections: await connections.list(companyId, actor) } };
      case "connections.call": {
        const name = input.params.name;
        if (!name || !CONNECTION_NAME_RE.test(name)) throw new DataError("invalid", "connection name is not valid");
        const b = input.body !== null && typeof input.body === "object" && !Array.isArray(input.body) ? (input.body as Record<string, unknown>) : {};
        const raw = { method: b.method, path: b.path, query: b.query, headers: b.headers, body: b.body };
        return { status: 200, body: await connections.call(companyId, actor, name, raw, { kind: "direct" }, guardFrom(input.body)) };
      }
      default:
        return { status: 404, body: { error: `unknown route ${input.routeKey}`, code: "not_found" } };
    }
  } catch (error) {
    if (error instanceof DataError) return { status: statusForError(error), body: errorBody(error) };
    log?.("connections api request failed", { routeKey: input.routeKey, companyId, error: String(error) });
    return { status: statusForError(error), body: { error: "error: internal error", code: "error" } };
  }
}
