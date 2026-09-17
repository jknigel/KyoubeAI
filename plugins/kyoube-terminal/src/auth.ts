import { TerminalError } from "./errors.js";

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

export class RoleResolver {
  private readonly cache = new Map<string, CacheEntry | Promise<CacheEntry>>();
  private readonly cacheMs: number;
  private readonly now: () => number;

  constructor(private readonly members: AccessMembersLike, opts: { cacheMs?: number; now?: () => number } = {}) {
    this.cacheMs = opts.cacheMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
  }

  async resolveRole(companyId: string, userId: string): Promise<string | null> {
    const entry = await this.load(companyId);
    return entry.roles.get(userId) ?? null;
  }

  /**
   * Ruling P4-R36, extending P4-R13: the caller's role read straight from the host, ignoring the
   * cache window (and refreshing it for later readers). `terminal.open` takes this path, because
   * opening a terminal is full instance access — the operation a just-removed or just-demoted
   * admin could do the most damage with, and the one a stale cache must not be able to grant.
   * Everything else keeps `resolveRole`: those actions are bound to a session the caller already
   * opened, and the same staleness there costs at most 30 seconds of an existing session.
   */
  async resolveFresh(companyId: string, userId: string): Promise<string | null> {
    const entry = await this.fetchAndCache(companyId);
    return entry.roles.get(userId) ?? null;
  }

  async assertAllowed(companyId: string, userId: string, allowedRoles: string[], opts: { fresh?: boolean } = {}): Promise<string> {
    const role = opts.fresh ? await this.resolveFresh(companyId, userId) : await this.resolveRole(companyId, userId);
    if (!role || !allowedRoles.includes(role)) {
      throw new TerminalError("forbidden", `the terminal is limited to company roles ${allowedRoles.join(", ")}`);
    }
    return role;
  }

  invalidate(companyId?: string): void {
    if (companyId) this.cache.delete(companyId);
    else this.cache.clear();
  }

  private async load(companyId: string): Promise<CacheEntry> {
    const cached = this.cache.get(companyId);
    if (cached instanceof Promise) {
      return cached;
    }
    if (cached && this.now() - cached.fetchedAt < this.cacheMs) {
      return cached;
    }

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
