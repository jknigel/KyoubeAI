export const KYOUBE_PROTOCOL = 1 as const;
export const ALLOWED_METHODS = ["data.query", "data.get", "data.count", "data.describe", "data.insert", "data.update", "data.delete", "ui.toast", "ui.openApp"] as const;
export type KyoubeMethod = (typeof ALLOWED_METHODS)[number];

/**
 * `nonce` (ruling P4-R18) is the per-mount handshake token the runner inlines into the app
 * document immediately ahead of this SDK. The SDK reads it once at install, deletes the global,
 * and repeats it on every request — the handshake included — so the host can tell a message from
 * the document it rendered apart from one posted by a document the frame navigated itself to
 * (which keeps the same WindowProxy, and so cannot be told apart by `event.source`). The protocol
 * version stays `1`: nothing but the runner and this SDK ever builds a request.
 */
export interface KyoubeRequest { kyoube: 1; id: string; method: KyoubeMethod; params: Record<string, unknown>; nonce: string }
export interface KyoubeResponse { kyoube: 1; id: string; result?: unknown; error?: { code: string; message: string } }
export interface KyoubeReadyEvent { kyoube: 1; event: "ready"; context: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && !Object.prototype.hasOwnProperty.call(value, "__proto__");
}

export function isKyoubeRequest(value: unknown): value is KyoubeRequest {
  return isRecord(value) && value.kyoube === KYOUBE_PROTOCOL && typeof value.id === "string" && typeof value.method === "string"
    && (ALLOWED_METHODS as readonly string[]).includes(value.method) && isRecord(value.params)
    // The value is compared against the mount's own nonce by the host; all this guard settles is
    // that there is one to compare, so a message with no nonce is never a request.
    && typeof value.nonce === "string";
}

export function isKyoubeResponse(value: unknown): value is KyoubeResponse {
  return isRecord(value) && value.kyoube === KYOUBE_PROTOCOL && typeof value.id === "string" && ("result" in value || isRecord(value.error));
}

export function isKyoubeReady(value: unknown): value is KyoubeReadyEvent {
  return isRecord(value) && value.kyoube === KYOUBE_PROTOCOL && value.event === "ready";
}
