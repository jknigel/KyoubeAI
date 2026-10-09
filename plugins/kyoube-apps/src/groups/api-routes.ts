import type { PluginApiRequestInput, PluginApiResponse, PluginApiRouteDeclaration } from "@paperclipai/plugin-sdk";
import { z } from "zod";
import { route } from "../api-routes.js";
import { DataError } from "../data/errors.js";
import type { GroupService } from "./service.js";

/** Board-only: `kyoube agent-rules --watch` reads agent access and reports each sync (docs/groups.md). */
export const GROUP_API_ROUTES: PluginApiRouteDeclaration[] = [
  route("groups.agent_access", "GET", "/groups/agent-access", "board"),
  route("groups.sync_report", "POST", "/groups/sync-report", "board"),
];

export interface GroupRouteHosts {
  listUserIds(companyId: string): Promise<Set<string>>;
  listAgentIds(companyId: string): Promise<Set<string>>;
}

const report = z.object({ syncedAt: z.iso.datetime(), error: z.string().max(2000).nullable() });

export async function handleGroupsApiRequest(
  service: Pick<GroupService, "agentAccess" | "recordSync">,
  input: PluginApiRequestInput,
  hosts: GroupRouteHosts,
  log?: (message: string, meta?: Record<string, unknown>) => void,
): Promise<PluginApiResponse | null> {
  if (!input.routeKey.startsWith("groups.")) return null;
  // Declared `auth: "board"`, which the host enforces; checked again so a mis-declared route could
  // never let an agent read who may assign which agent.
  if (input.actor.actorType === "agent") return { status: 403, body: { error: "forbidden: board access required", code: "forbidden" } };
  try {
    if (input.routeKey === "groups.agent_access") {
      const [userIds, agentIds] = await Promise.all([hosts.listUserIds(input.companyId), hosts.listAgentIds(input.companyId)]);
      return { status: 200, body: { agents: await service.agentAccess(input.companyId, { userIds, agentIds }) } };
    }
    if (input.routeKey === "groups.sync_report") {
      const parsed = report.safeParse(input.body ?? {});
      if (!parsed.success) return { status: 400, body: { error: "invalid sync report", code: "invalid" } };
      await service.recordSync(input.companyId, parsed.data);
      return { status: 200, body: { ok: true } };
    }
    return { status: 404, body: { error: `unknown route ${input.routeKey}`, code: "not_found" } };
  } catch (error) {
    if (error instanceof DataError) return { status: error.code === "invalid" ? 400 : 500, body: { error: error.message, code: error.code } };
    log?.("groups api request failed", { routeKey: input.routeKey, companyId: input.companyId, error: String(error) });
    return { status: 500, body: { error: "error: internal error", code: "error" } };
  }
}
