import type { PluginContext, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { z } from "zod";
import { GUARD_NOTE, guardFrom, guardToolParams } from "../decisions/guardrail.js";
import { declarationsFor, registerToolHandlers, type ToolDefinition } from "../tool-runtime.js";
import { CONNECTION_NAME_RE } from "./config.js";
import type { ConnectionService } from "./service.js";

const name = z.string().regex(CONNECTION_NAME_RE, "name must match ^[a-z][a-z0-9_-]{0,39}$").describe("the connection's name, from connections_list");

export const CONNECTION_TOOL_DEFINITIONS: ToolDefinition<ConnectionService>[] = [
  { name: "connections_list", displayName: "List connections", description: "List the outside services this company has connected (name, base URL, whether it is available, and your own access: none, read or read-write). Secrets are never shown.", schema: z.object({}), run: (s, c, a) => s.list(c, a) },
  {
    name: "connections_call",
    displayName: "Call connection",
    description: `Call a connected outside service as the company, using its stored credentials. You need a grant for the connection (see connections_list); a read grant allows GET only. path is relative to the connection's base URL. Returns { status, headers, body } with body as text.${GUARD_NOTE}`,
    schema: z.object({
      name,
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
      path: z.string().optional().describe("path under the connection's base URL, e.g. /v1/items"),
      query: z.record(z.string(), z.string()).optional(),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.unknown().optional().describe("request body; objects are sent as JSON"),
      ...guardToolParams,
    }),
    run: (s, c, a, p) => s.call(c, a, p.name, { method: p.method, path: p.path, query: p.query, headers: p.headers, body: p.body }, { kind: "direct" }, guardFrom(p)),
  },
];

export const connectionToolDeclarations = (): PluginToolDeclaration[] => declarationsFor(CONNECTION_TOOL_DEFINITIONS);
export const registerConnectionTools = (ctx: PluginContext, connections: ConnectionService): void => registerToolHandlers(ctx, CONNECTION_TOOL_DEFINITIONS, connections);
