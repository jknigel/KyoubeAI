const KNOWN_CODES = ["forbidden", "not_found", "invalid", "conflict", "exists", "limit"] as const;

/**
 * The message text of a rejected host bridge call. A rejection from
 * `usePluginAction` is a plain `{ code, message, details }` object, not an
 * `Error` (upstream's `extractBridgeError`), so `String(error)` on one renders
 * "[object Object]". Same helper as the terminal and apps plugins carry; the
 * plugins do not share code.
 */
export function bridgeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || "error";
  if (typeof error === "string") return error || "error";
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "error";
}

/**
 * The worker's own `<code>: <text>` code, found as the leftmost known code
 * token in the message (the host may prefix the text and its own `code` field
 * is a transport code, never the worker's). `"error"` when none is present.
 */
export function errorCodeFrom(error: unknown): string {
  const message = bridgeErrorMessage(error);
  let bestIndex = -1;
  let bestCode = "error";
  for (const code of KNOWN_CODES) {
    const match = new RegExp(`\\b${code}\\b`).exec(message);
    if (match && (bestIndex === -1 || match.index < bestIndex)) {
      bestIndex = match.index;
      bestCode = code;
    }
  }
  return bestCode;
}

/** The text a banner shows for a failed action: the worker's sentence without the host's wrapping and the code prefix. */
export function errorText(error: unknown): string {
  const message = bridgeErrorMessage(error);
  const code = errorCodeFrom(error);
  if (code === "error") return message;
  const index = message.indexOf(`${code}: `);
  return index === -1 ? message : message.slice(index + code.length + 2);
}
