import { DataError } from "../data/errors.js";
import type { ProviderTarget } from "./client.js";

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
      type: "string",
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

/** The core allows 30 secret lookups a minute per company; one cached key per company stays far below it. */
export const SECRET_CACHE_MS = 60_000;

export interface ProviderResolverDeps {
  getConfig(companyId: string): Promise<Record<string, unknown>>;
  resolveSecret(ref: unknown, companyId: string): Promise<string>;
  now?(): number;
  ttlMs?: number;
}

export class ProviderResolver {
  /** Worker memory only: never logged, never written anywhere, dropped on a config change. */
  private readonly keys = new Map<string, { ref: string; value: string; expires: number }>();

  constructor(private readonly deps: ProviderResolverDeps) {}

  async settings(companyId: string): Promise<ProviderSettings | null> {
    return parseProviderSettings((await this.deps.getConfig(companyId)) ?? {});
  }

  async resolve(companyId: string): Promise<ProviderTarget> {
    const settings = await this.settings(companyId);
    if (!settings) {
      throw new DataError("disabled", "no typed-decisions provider is set for this company; an instance admin sets one in the Kyoube Data & Apps plugin settings");
    }
    const ref = JSON.stringify(settings.apiKeyRef);
    const now = this.deps.now?.() ?? Date.now();
    const cached = this.keys.get(companyId);
    let apiKey: string;
    if (cached && cached.ref === ref && cached.expires > now) {
      apiKey = cached.value;
    } else {
      try {
        apiKey = await this.deps.resolveSecret(settings.apiKeyRef, companyId);
      } catch (error) {
        throw new DataError("disabled", "the typed-decisions API key could not be read; check the secret picked in the plugin settings", { cause: error });
      }
      this.keys.set(companyId, { ref, value: apiKey, expires: now + (this.deps.ttlMs ?? SECRET_CACHE_MS) });
    }
    return { provider: settings.provider, baseUrl: settings.baseUrl, model: settings.model, apiKey };
  }

  invalidate(companyId?: string | null): void {
    if (companyId) this.keys.delete(companyId);
    else this.keys.clear();
  }
}
