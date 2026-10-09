import type { PluginApiRequestInput, PluginApiResponse, PluginApiRouteDeclaration } from "@paperclipai/plugin-sdk";
import { z } from "zod";
import { route } from "../api-routes.js";
import { DataError } from "../data/errors.js";
import { isManagerRole } from "./levels.js";
import type { GroupService } from "./service.js";

/**
 * `kyoube agent-rules --watch` reads agent access and reports each sync (docs/groups.md). Declared
 * `auth: "board"`, which the host grants every signed-in person, so the handler also requires a
 * company owner or admin, read fresh from the core (ruling R13).
 */
export const GROUP_API_ROUTES: PluginApiRouteDeclaration[] = [
  route("groups.agent_access", "GET", "/groups/agent-access", "board"),
  route("groups.sync_report", "POST", "/groups/sync-report", "board"),
];

export interface GroupRouteHosts {
  listUserIds(companyId: string): Promise<Set<string>>;
  listAgentIds(companyId: string): Promise<Set<string>>;
  /** The caller's company role, read fresh from the core (never the 30 s cache). */
  resolveRoleFresh(companyId: string, userId: string): Promise<string | null>;
}

const FORBIDDEN = { error: "forbidden: company owner or admin required", code: "forbidden" } as const;

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
    // "board" admits every signed-in person. Only an owner or admin, by a fresh role read, may read
    // the membership map or record a sync (ruling R13); checked before any work.
    const userId = input.actor.userId ?? input.actor.actorId;
    if (input.actor.actorType !== "user" || !userId || !isManagerRole(await hosts.resolveRoleFresh(input.companyId, userId))) {
      return { status: 403, body: { ...FORBIDDEN } };
    }
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
