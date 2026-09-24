import { definePlugin, type PaperclipPlugin, type PluginContext } from "@paperclipai/plugin-sdk";
import { buildHome, summarizeTeam, type AgentLike, type ApprovalLike, type IssueLike } from "./model.js";
import { buildProfile, type CommentLike, type ProfileAgentLike } from "./profile.js";

type Params = Record<string, unknown>;

export interface StudioPluginDeps {
  now?: () => number;
  /** How long one company's snapshot is reused, so a roster that polls and a Home that polls share one read. */
  snapshotMs?: number;
}

interface Snapshot {
  agents: AgentLike[];
  issues: IssueLike[];
  approvals: ApprovalLike[];
}

/** Tasks read per snapshot. The host lists newest activity first; older ones do not change what Studio shows. */
const ISSUE_WINDOW = 500;
/** Company roles that see the Terminal card on the Workspace page (the terminal plugin's default roles). */
const ADMIN_ROLES = new Set(["owner", "admin"]);

function companyOf(params: Params): string {
  // The host puts the caller's authorized company in `companyId` and refuses
  // a bridge call without one unless the caller is an instance admin.
  const companyId = params.companyId;
  if (typeof companyId !== "string" || companyId.length === 0) throw new Error("companyId is required");
  return companyId;
}

export function createStudioPlugin(deps: StudioPluginDeps = {}): PaperclipPlugin {
  const now = deps.now ?? (() => Date.now());
  const snapshotMs = deps.snapshotMs ?? 8_000;
  const snapshots = new Map<string, { at: number; value: Promise<Snapshot> }>();

  return definePlugin({
    async setup(ctx: PluginContext) {
      /** One company's agents, tasks and pending approvals; `fresh` skips (and replaces) the short-lived cache. */
      const load = (companyId: string, { fresh = false }: { fresh?: boolean } = {}): Promise<Snapshot> => {
        const cached = snapshots.get(companyId);
        if (!fresh && cached && now() - cached.at < snapshotMs) return cached.value;
        const value = (async () => {
          const [agents, issues, approvals] = await Promise.all([
            ctx.agents.list({ companyId }),
            ctx.issues.list({ companyId, limit: ISSUE_WINDOW }),
            ctx.approvals.list({ companyId, status: "pending" }),
          ]);
          return { agents, issues, approvals } as unknown as Snapshot;
        })();
        snapshots.set(companyId, { at: now(), value });
        // A failed read must not be served from the cache for the next 8 s.
        value.catch(() => { if (snapshots.get(companyId)?.value === value) snapshots.delete(companyId); });
        return value;
      };

      ctx.data.register("team", async (params) => {
        const { agents, issues } = await load(companyOf(params));
        return summarizeTeam(agents, issues);
      });

      ctx.data.register("home", async (params) => {
        const { agents, issues, approvals } = await load(companyOf(params));
        return buildHome(agents, issues, approvals, now());
      });

      ctx.data.register("agent", async (params) => {
        const companyId = companyOf(params);
        const ref = typeof params.agentRef === "string" ? params.agentRef : "";
        if (!ref) throw new Error("agentRef is required");
        // Always a fresh read: the profile is where people pause an agent or
        // assign it a task, and must show the result on its next refresh.
        const { agents, issues } = await load(companyId, { fresh: true });
        const first = buildProfile(ref, agents as ProfileAgentLike[], issues, [], now());
        if (!first.found || !first.current) return first;
        // The agent's own latest notes on the task it is working on. Read per
        // request (one task, one call) rather than cached with the snapshot.
        const comments = await ctx.issues.listComments(first.current.task.id, companyId).catch(() => []);
        return buildProfile(ref, agents as ProfileAgentLike[], issues, comments as unknown as CommentLike[], now());
      });

      ctx.data.register("workspace", async (params) => {
        const companyId = companyOf(params);
        const [{ agents, issues }, projects, members] = await Promise.all([
          load(companyId),
          ctx.projects.list({ companyId }),
          ctx.access.members.list({ companyId }).catch(() => []),
        ]);
        const userId = typeof params.userId === "string" ? params.userId : null;
        const me = (members as Array<{ principalType: string; principalId: string; status: string; membershipRole: string | null }>)
          .find((member) => member.principalType === "user" && member.principalId === userId && member.status === "active");
        const open = issues.filter((issue) => issue.hiddenAt == null && !["done", "cancelled"].includes(issue.status)).length;
        const people = (members as Array<{ principalType: string; status: string }>).filter((member) => member.principalType === "user" && member.status === "active").length;
        return {
          agents: agents.filter((agent) => agent.status !== "terminated").length,
          people,
          projects: projects.filter((project) => (project as { archivedAt?: unknown }).archivedAt == null).length,
          openTasks: open,
          // Cosmetic only: the Terminal page enforces its own access.
          isAdmin: me ? ADMIN_ROLES.has(me.membershipRole ?? "") : false,
        };
      });
    },

    async onHealth() {
      return { status: "ok", message: "Kyoube Studio is ready" };
    },
  });
}
