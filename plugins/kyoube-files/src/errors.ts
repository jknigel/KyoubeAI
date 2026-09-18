export type FilesErrorCode = "forbidden" | "not_found" | "invalid" | "conflict" | "exists" | "limit";

/** Thrown from actions; the message is `<code>: <text>` so the UI can branch on the code. */
export class FilesError extends Error {
  readonly code: FilesErrorCode;
  constructor(code: FilesErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "FilesError";
    this.code = code;
  }
}
