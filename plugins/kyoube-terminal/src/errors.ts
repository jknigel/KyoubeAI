export type TerminalErrorCode = "forbidden" | "not_found" | "limit" | "closed" | "invalid";

/** Thrown from actions; the message is `<code>: <text>` so the UI can branch on the code. */
export class TerminalError extends Error {
  readonly code: TerminalErrorCode;
  constructor(code: TerminalErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "TerminalError";
    this.code = code;
  }
}
