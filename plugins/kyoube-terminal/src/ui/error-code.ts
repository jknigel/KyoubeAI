const KNOWN_CODES = ["forbidden", "not_found", "limit", "closed", "invalid"] as const;

/**
 * The message text of a rejected host bridge call (ruling P3-R17 carry-over).
 * A rejection from `usePluginAction` is *not* an `Error`: upstream's
 * `extractBridgeError` (2026.831.1, `ui/src/plugins/bridge.ts`) returns a
 * plain object literal `{ code, message, details }` — `PluginBridgeError` is
 * an interface, with no class behind it — so `String(error)` on one renders
 * "[object Object]", which contains none of the worker's `<code>: <text>`
 * wording for `errorCodeFrom`'s scan below to find. Mirrors the apps plugin's
 * `bridgeErrorMessage` (`src/ui/format.ts`); the two plugins do not share code.
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
 * Extracts a known `TerminalErrorCode` from a bridge error. The worker throws
 * `<code>: <text>`, but the host's rejection object's own `code` is a
 * transport code (`WORKER_ERROR`, `TIMEOUT`, …), never the worker's, and the
 * host may also wrap the text with its own prefix (e.g. "Plugin action
 * failed: forbidden: …") — so the code is not reliably the text before the
 * first colon, nor the rejection's own `code` field. Instead, search the
 * whole message for the first (leftmost) known code token, matched as a whole
 * word. Returns `"error"` when no known code is present.
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

export interface ActionError {
  /** A `TerminalErrorCode`, or `"error"`; the page branches on it (e.g. refresh the list on `not_found`). */
  readonly code: string;
  /** What the banner shows. */
  readonly text: string;
}

/**
 * What a failed action puts in the page's banner. The page used to show only the extracted code
 * ("Error: limit"), throwing away the worker's own sentence — the part that says *which* limit,
 * or *which* session is gone (Phase 1 deferred minor).
 *
 * `hint` is the caller's plainer wording for a role denial: it is used only for `forbidden`, and
 * only where the caller knows the denial can mean nothing else, so a `forbidden` from, say,
 * attaching another user's session is never mislabelled as a role problem.
 */
export function actionErrorFrom(error: unknown, hint?: string): ActionError {
  const code = errorCodeFrom(error);
  const message = bridgeErrorMessage(error);
  return { code, text: hint && code === "forbidden" ? `${hint} (${message})` : `Error: ${message}` };
}
