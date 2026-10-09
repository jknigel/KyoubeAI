import type { Pool } from "pg";
import { z } from "zod";
import { withMeta, type AuditEntry } from "../data/audit.js";
import { DataError } from "../data/errors.js";
import type { DataActor } from "../data/permissions.js";
import type { MutationEvent } from "../data/service.js";
import { ensureCompany, schemaNameFor } from "../db/company-scope.js";
import { isManagerRole, parseGroupLevel, type GroupLevel } from "./levels.js";
import type { LicenceGate } from "./licence.js";
import { GroupStore, type AgentAccess, type GroupInput, type GroupRecord, type SyncReport } from "./store.js";

export const MAX_GROUPS = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ids = z.array(z.string().min(1).max(200)).max(5000).transform((list) => [...new Set(list)].sort());
const body = z.object({
  id: z.string().regex(UUID).optional(),
  name: z.string().transform((name) => name.trim()).pipe(z.string().min(1).max(80)),
  dataLevel: z.unknown().optional(),
  members: ids,
  agents: ids,
  apps: z.array(z.string().regex(UUID, "apps must be app ids")).max(5000).transform((list) => [...new Set(list.map((id) => id.toLowerCase()))].sort()),
});

export interface GroupServiceDeps {
  pool: Pool;
  resolveUserRole: (companyId: string, userId: string, fresh: boolean) => Promise<string | null>;
  licence: LicenceGate;
  onMutation?: (event: MutationEvent) => Promise<void>;
  onMutationError?: (error: unknown, event: MutationEvent) => void;
}

export class GroupService {
  private readonly store: GroupStore;

  constructor(private readonly deps: GroupServiceDeps) {
    this.store = new GroupStore(deps.pool);
  }

  async list(companyId: string, actor: DataActor): Promise<{ unlocked: boolean; groups: GroupRecord[]; sync: SyncReport | null }> {
    await this.assertManager(companyId, actor);
    const [unlocked, groups, sync] = await Promise.all([this.deps.licence.unlocked(), this.store.list(companyId), this.store.getSync(companyId)]);
    return { unlocked, groups, sync };
  }

  async save(companyId: string, actor: DataActor, raw: unknown): Promise<GroupRecord> {
    await this.assertManager(companyId, actor);
    const parsed = body.safeParse(raw);
    if (!parsed.success) throw new DataError("invalid", parsed.error.issues.map((issue) => `${issue.path.join(".") || "group"} ${issue.message}`).join("; "));
    const input: GroupInput = { name: parsed.data.name, dataLevel: parseGroupLevel(parsed.data.dataLevel), members: parsed.data.members, agents: parsed.data.agents, apps: parsed.data.apps };
    if (!(await this.deps.licence.unlocked())) throw new DataError("disabled", "managing groups needs a KyoubeAI licence; existing groups are still enforced and can be deleted");
    await ensureCompany(this.deps.pool, companyId);
    await this.assertOwnApps(companyId, input.apps);
    const id = parsed.data.id;
    if (!id && (await this.store.count(companyId)) >= MAX_GROUPS) throw new DataError("limit", `a company can have at most ${MAX_GROUPS} groups`);
    const saved = await withMeta(this.deps.pool, async (client) => {
      if (!id) return this.store.create(client, companyId, input);
      const replaced = await this.store.replace(client, companyId, id, input);
      if (!replaced) throw new DataError("not_found", "no such group");
      return replaced;
    }, (group) => this.entry(companyId, actor, id ? "group_update" : "group_create", group));
    await this.notify(companyId, actor, id ? "group_update" : "group_create", saved.id, `${id ? "updated" : "created"} a group`);
    return saved;
  }

  /** Allowed without a licence: deleting can only lift restrictions, and must never be blocked. */
  async remove(companyId: string, actor: DataActor, id: string): Promise<{ deleted: GroupRecord }> {
    await this.assertManager(companyId, actor);
    if (!UUID.test(id)) throw new DataError("invalid", "id must be a group id");
    const deleted = await withMeta(this.deps.pool, async (client) => {
      const removed = await this.store.remove(client, companyId, id);
      if (!removed) throw new DataError("not_found", "no such group");
      return removed;
    }, (group) => this.entry(companyId, actor, "group_delete", group));
    await this.notify(companyId, actor, "group_delete", deleted.id, "deleted a group");
    return { deleted };
  }

  levelsForUser(companyId: string, userId: string): Promise<GroupLevel[]> {
    return this.store.levelsForUser(companyId, userId);
  }

  async hiddenApps(companyId: string, userId: string): Promise<Set<string>> {
    if (isManagerRole(await this.deps.resolveUserRole(companyId, userId, false))) return new Set();
    return this.store.hiddenAppIds(companyId, userId);
  }

  async agentAccess(companyId: string, keep: { userIds: Set<string>; agentIds: Set<string> }): Promise<AgentAccess[]> {
    schemaNameFor(companyId);
    // An empty user listing is never believed: a failed or odd host listing must not wipe membership.
    // An empty agent listing is real (a company with no agents), so agents are still pruned.
    let userIds = keep.userIds;
    if (userIds.size === 0) userIds = new Set((await this.store.list(companyId)).flatMap((group) => group.members));
    await this.store.prune(companyId, { userIds, agentIds: keep.agentIds });
    return this.store.agentAccess(companyId);
  }

  async recordSync(companyId: string, report: SyncReport): Promise<void> {
    schemaNameFor(companyId);
    await ensureCompany(this.deps.pool, companyId);
    await this.store.setSync(companyId, report);
  }

  /** The store's FK only proves an app exists, not that it is this company's. */
  private async assertOwnApps(companyId: string, appIds: string[]): Promise<void> {
    if (appIds.length === 0) return;
    const found = await this.deps.pool.query<{ id: string }>("SELECT id FROM kyoube_meta.apps WHERE company_id = $1 AND id = ANY($2::uuid[])", [companyId, appIds]);
    if (found.rows.length !== appIds.length) throw new DataError("invalid", "apps must be this company's apps");
  }

  private async assertManager(companyId: string, actor: DataActor): Promise<void> {
    schemaNameFor(companyId);
    if (actor.kind !== "user" || !actor.id) throw new DataError("forbidden", "only company owners and admins manage groups");
    if (!isManagerRole(await this.deps.resolveUserRole(companyId, actor.id, true))) throw new DataError("forbidden", "only company owners and admins manage groups");
  }

  private entry(companyId: string, actor: DataActor, operation: string, group: GroupRecord): AuditEntry {
    // Ids only: a group's name can name people ("Alice's team"), and audit rows never carry them.
    return { companyId, actor, operation, table: null, details: { groupId: group.id, dataLevel: group.dataLevel, members: group.members, agents: group.agents, apps: group.apps } };
  }

  private async notify(companyId: string, actor: DataActor, operation: string, groupId: string, summary: string): Promise<void> {
    if (!this.deps.onMutation) return;
    const event: MutationEvent = { companyId, actor, operation, table: null, entityId: groupId, summary };
    try { await this.deps.onMutation(event); } catch (error) { this.deps.onMutationError?.(error, event); }
  }
}