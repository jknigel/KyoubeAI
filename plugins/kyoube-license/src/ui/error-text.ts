/**
 * The message of a rejected host bridge call. A `usePluginAction` rejection is
 * a plain `{ code, message }` object, not an Error, so `String(error)` would
 * print "[object Object]" (same reason as the files plugin's helper; plugins
 * don't share code).
 */
export function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "Something went wrong.";
}
