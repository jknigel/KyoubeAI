/** The core allows 30 secret lookups a minute per company; one cached value per slot stays far below it. */
export const SECRET_CACHE_MS = 60_000;

export interface SecretCacheDeps {
  resolve(binding: unknown, companyId: string, configPath: string): Promise<string>;
  now?(): number;
  ttlMs?: number;
}

interface Entry { ref: string; configPath: string; value: string; expires: number }
interface Running { ref: string; configPath: string; generation: string; promise: Promise<string> }

export class SecretCache {
  /** Worker memory only: never logged, never written anywhere, dropped on a config change. */
  private readonly values = new Map<string, Entry>();
  /** The lookup under way per company and slot, shared by every caller that finds the cache cold meanwhile. */
  private readonly inflight = new Map<string, Running>();
  /** Bumped by `invalidate`, so a lookup that started before a config change never fills the cache after it. */
  private readonly generations = new Map<string, number>();
  private epoch = 0;

  constructor(private readonly deps: SecretCacheDeps) {}

  /** `slot` names the secret within the company (e.g. "decisions", "connection:stripe"). A failed lookup rejects with the resolver's error and is not kept. */
  async get(companyId: string, slot: string, binding: unknown, configPath: string): Promise<string> {
    const key = `${companyId}\u0000${slot}`;
    const ref = JSON.stringify(binding);
    const now = this.deps.now?.() ?? Date.now();
    const cached = this.values.get(key);
    if (cached && cached.ref === ref && cached.configPath === configPath && cached.expires > now) return cached.value;
    return this.lookup(companyId, key, ref, binding, configPath, now);
  }

  invalidate(companyId?: string | null): void {
    if (companyId) {
      this.generations.set(companyId, (this.generations.get(companyId) ?? 0) + 1);
      const prefix = `${companyId}\u0000`;
      for (const key of [...this.values.keys()]) if (key.startsWith(prefix)) this.values.delete(key);
      for (const key of [...this.inflight.keys()]) if (key.startsWith(prefix)) this.inflight.delete(key);
    } else {
      this.epoch += 1;
      this.values.clear();
      this.inflight.clear();
    }
  }

  private generation(companyId: string): string {
    return `${this.epoch}:${this.generations.get(companyId) ?? 0}`;
  }

  /**
   * One secret lookup per company, slot and reference at a time: the core allows 30 a minute, and a
   * burst of rows or app calls on a cold cache must not spend them all. A failed lookup is not kept.
   */
  private lookup(companyId: string, key: string, ref: string, binding: unknown, configPath: string, startedAt: number): Promise<string> {
    const generation = this.generation(companyId);
    const running = this.inflight.get(key);
    if (running && running.ref === ref && running.configPath === configPath && running.generation === generation) return running.promise;
    let settle!: { resolve(value: string): void; reject(error: unknown): void };
    const promise = new Promise<string>((resolve, reject) => { settle = { resolve, reject }; });
    const entry: Running = { ref, configPath, generation, promise };
    // In place before the lookup starts, so even a secret port that throws at once clears it below.
    this.inflight.set(key, entry);
    void (async () => {
      try {
        const value = await this.deps.resolve(binding, companyId, configPath);
        if (this.generation(companyId) === generation) {
          this.values.set(key, { ref, configPath, value, expires: startedAt + (this.deps.ttlMs ?? SECRET_CACHE_MS) });
        }
        settle.resolve(value);
      } catch (error) {
        settle.reject(error);
      } finally {
        if (this.inflight.get(key) === entry) this.inflight.delete(key);
      }
    })();
    return promise;
  }
}
