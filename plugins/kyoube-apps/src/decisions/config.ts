import { DataError } from "../data/errors.js";
import type { ProviderTarget } from "./client.js";
import { SECRET_CACHE_MS, SecretCache } from "../secrets/cache.js";

export const PROVIDER_PRESETS = {
  typesafe: "https://api.typesafe.ai",
  openrouter: "https://openrouter.ai/api",
  vercel: "https://ai-gateway.vercel.sh/typesafe",
} as const;
export type ProviderName = keyof typeof PROVIDER_PRESETS | "custom";
const PROVIDERS: readonly string[] = [...Object.keys(PROVIDER_PRESETS), "custom"];

/** The config path the core binds the key secret at; `ctx.secrets.resolve` needs it when asked. */
export const API_KEY_CONFIG_PATH = "decisionsApiKey";

/**
 * The plugin's per-company config (core plugin settings, saved by an instance admin). The key is a
 * `secret-ref` field, as the core's own plugins declare one: the settings page shows the secret
 * picker and the core stores `{ type: "secret_ref", secretId, version }` and binds it.
 */
export const DECISIONS_CONFIG_SCHEMA = {
  type: "object",
  properties: {
    decisionsProvider: {
      type: "string",
      title: "Typed decisions: provider",
      enum: ["typesafe", "openrouter", "vercel", "custom"],
      description: "Where typed decisions are sent. Leave empty to keep typed decisions off for this company.",
    },
    decisionsBaseUrl: {
      type: "string",
      title: "Typed decisions: custom base URL",
      description: "Only for the custom provider. Must start with https://; the worker calls <base URL>/v1/systemone.",
    },
    decisionsApiKey: {
      // The core validates the saved value against this schema with ajv, and the value is the
      // `{ type: "secret_ref", ... }` object, so `string` alone would reject every save (smoke, core
      // 2026.916.1). The settings form still renders the secret picker, which keys on `format`.
      type: ["string", "object"],
      format: "secret-ref",
      title: "Typed decisions: API key",
      description: "A company secret holding the provider's API key.",
    },
    decisionsModel: {
      type: "string",
      title: "Typed decisions: model",
      description: "A pinned model version, such as jev-1.13.0 (TypeSafe) or typesafe/jev-1.13 (OpenRouter). Names ending in latest are refused, because the answers behind them change without notice.",
    },
  },
};
// Deliberately not `as const`: the manifest's `instanceConfigSchema` is a mutable JSON Schema type,
// and a readonly `enum` tuple is not assignable to it.

export interface ProviderSettings { provider: ProviderName; baseUrl: string; model: string; apiKeyRef: unknown }

function broken(reason: string): DataError {
  return new DataError("disabled", `typed decisions are not set up correctly for this company: ${reason}`);
}

/** Null when the company has no provider; `disabled` with the reason when its config is unusable. */
export function parseProviderSettings(raw: Record<string, unknown>): ProviderSettings | null {
  const provider = raw.decisionsProvider;
  if (provider === undefined || provider === null || provider === "") return null;
  if (typeof provider !== "string" || !PROVIDERS.includes(provider)) throw broken(`unknown provider "${String(provider)}"`);
  let baseUrl: string;
  if (provider === "custom") {
    const value = typeof raw.decisionsBaseUrl === "string" ? raw.decisionsBaseUrl.trim() : "";
    if (!value) throw broken("the custom provider needs a base URL");
    let url: URL;
    try { url = new URL(value); } catch { throw broken("the custom base URL is not a URL"); }
    if (url.protocol !== "https:") throw broken("the custom base URL must start with https://");
    if (url.username || url.password || url.search || url.hash) throw broken("the custom base URL must not carry credentials, a query or a fragment");
    baseUrl = url.toString().replace(/\/+$/, "");
  } else {
    baseUrl = PROVIDER_PRESETS[provider as keyof typeof PROVIDER_PRESETS];
  }
  const model = typeof raw.decisionsModel === "string" ? raw.decisionsModel.trim() : "";
  if (!model) throw broken("set a pinned model");
  if (/latest$/i.test(model)) throw broken(`"${model}" moves between releases; set a pinned model version`);
  const apiKeyRef = raw.decisionsApiKey;
  if (apiKeyRef === undefined || apiKeyRef === null || apiKeyRef === "") throw broken("pick the API key secret");
  return { provider: provider as ProviderName, baseUrl, model, apiKeyRef };
}

export function validateDecisionsConfig(raw: Record<string, unknown>): { ok: boolean; errors?: string[] } {
  try {
    parseProviderSettings(raw);
    return { ok: true };
  } catch (error) {
    return { ok: false, errors: [error instanceof DataError ? error.message : String(error)] };
  }
}

export { SECRET_CACHE_MS };

export interface ProviderResolverDeps {
  getConfig(companyId: string): Promise<Record<string, unknown>>;
  resolveSecret(ref: unknown, companyId: string): Promise<string>;
  now?(): number;
  ttlMs?: number;
  /** Shared with the other secret users in the plugin; one is made from `resolveSecret` when absent. */
  cache?: SecretCache;
}

export class ProviderResolver {
  private readonly cache: SecretCache;

  constructor(private readonly deps: ProviderResolverDeps) {
    this.cache = deps.cache ?? new SecretCache({
      resolve: (binding, companyId) => deps.resolveSecret(binding, companyId),
      now: deps.now,
      ttlMs: deps.ttlMs,
    });
  }

  async settings(companyId: string): Promise<ProviderSettings | null> {
    return parseProviderSettings((await this.deps.getConfig(companyId)) ?? {});
  }

  async resolve(companyId: string): Promise<ProviderTarget> {
    const settings = await this.settings(companyId);
    if (!settings) {
      throw new DataError("disabled", "no typed-decisions provider is set for this company; an instance admin sets one in the Kyoube Data & Apps plugin settings");
    }
    let apiKey: string;
    try {
      apiKey = await this.cache.get(companyId, "decisions", settings.apiKeyRef, API_KEY_CONFIG_PATH);
    } catch (error) {
      throw new DataError("disabled", "the typed-decisions API key could not be read; check the secret picked in the plugin settings", { cause: error });
    }
    return { provider: settings.provider, baseUrl: settings.baseUrl, model: settings.model, apiKey };
  }

  invalidate(companyId?: string | null): void {
    this.cache.invalidate(companyId);
  }
}
