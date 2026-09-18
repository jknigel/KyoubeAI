import { FilesError } from "./errors.js";

export interface AccessMemberRow {
  principalType: string;
  principalId: string;
  status: string;
  membershipRole: string | null;
}

export interface AccessMembersLike {
  list(input: { companyId: string }): Promise<AccessMemberRow[]>;
}

interface CacheEntry {
  fetchedAt: number;
  roles: Map<string, string>; // userId -> role
}

/**
 * The caller's company role, from the host's members API, cached for 30 s per
 * company. Same shape as the terminal and apps plugins' resolvers (plugins do
 * not share code): a read takes the cached answer, a write asks the host again
 * (`fresh`), so a demoted or removed member can browse for at most 30 more
 * seconds and cannot change a file at all once the change lands.
 */
export class RoleResolver {
  private readonly cache = new Map<string, CacheEntry | Promise<CacheEntry>>();
  private readonly cacheMs: number;
  private readonly now: () => number;

  constructor(private readonly members: AccessMembersLike, opts: { cacheMs?: number; now?: () => number } = {}) {
    this.cacheMs = opts.cacheMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
  }

  async resolveRole(companyId: string, userId: string, opts: { fresh?: boolean } = {}): Promise<string | null> {
    const entry = opts.fresh ? await this.fetchAndCache(companyId) : await this.load(companyId);
    return entry.roles.get(userId) ?? null;
  }

  async assertAllowed(companyId: string, userId: string, allowedRoles: string[], what: string, opts: { fresh?: boolean } = {}): Promise<string> {
    const role = await this.resolveRole(companyId, userId, opts);
    if (!role || !allowedRoles.includes(role)) {
      throw new FilesError("forbidden", `${what} is limited to company roles ${allowedRoles.join(", ")}`);
    }
    return role;
  }

  invalidate(companyId?: string): void {
    if (companyId) this.cache.delete(companyId);
    else this.cache.clear();
  }

  private async load(companyId: string): Promise<CacheEntry> {
    const cached = this.cache.get(companyId);
    if (cached instanceof Promise) return cached;
    if (cached && this.now() - cached.fetchedAt < this.cacheMs) return cached;
    const pending = this.fetchAndCache(companyId);
    this.cache.set(companyId, pending);
    return pending;
  }

  private async fetchAndCache(companyId: string): Promise<CacheEntry> {
    try {
      const rows = await this.members.list({ companyId });
      const roles = new Map<string, string>();
      for (const row of rows) {
        if (row.principalType !== "user" || row.status !== "active" || !row.membershipRole) continue;
        roles.set(row.principalId, row.membershipRole.toLowerCase());
      }
      const entry = { fetchedAt: this.now(), roles };
      this.cache.set(companyId, entry);
      return entry;
    } catch (err) {
      this.cache.delete(companyId);
      throw err;
    }
  }
}
