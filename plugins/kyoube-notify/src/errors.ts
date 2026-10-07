export type NotifyErrorCode = "forbidden" | "invalid" | "not_found";

/** Thrown from actions; the message is `<code>: <text>` so the UI can branch on the code (the Files plugin's convention). */
export class NotifyError extends Error {
  readonly code: NotifyErrorCode;
  constructor(code: NotifyErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "NotifyError";
    this.code = code;
  }
}
