import { rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** A Claude setup-token (`claude setup-token`): an OAuth token valid for a year. */
export const SETUP_TOKEN_RE = /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/;
// The lines `claude setup-token`'s success screen prints around the token. The core parses the
// same screen with the same anchors (packages/adapters/claude-local/src/server/setup-token-parse.ts).
const BEFORE = "Your OAuth token (valid for 1 year):";
const AFTER = "Store this token securely. You won't be able to see it again.";
const FRAGMENT_RE = /^[A-Za-z0-9_-]+$/;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function stripTerminalCodes(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/\r/g, "");
}

/** The token from a captured `claude setup-token` session, or null when the screen does not hold one. */
export function extractSetupToken(transcript: string): string | null {
  const lines = stripTerminalCodes(transcript).split("\n").map((line) => line.trim());
  const start = lines.lastIndexOf(BEFORE);
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && line === AFTER);
  if (end === -1) return null;
  const token = lines.slice(start + 1, end).filter((line) => FRAGMENT_RE.test(line)).join("");
  return SETUP_TOKEN_RE.test(token) ? token : null;
}

/** True only for `<home>/instances/<instance>/ai-local-logins/<attempt>`, the folder Connections creates for one sign-in. */
export function isSignInAttemptDir(dir: string, home: string): boolean {
  if (!dir) return false;
  const relative = path.posix.relative(path.posix.resolve(home), path.posix.resolve(dir));
  const parts = relative.split("/");
  return parts.length === 4 && parts[0] === "instances" && parts[2] === "ai-local-logins" && parts.every((part) => part && part !== "..");
}

export function renderCredentials(token: string, nowMs: number): string {
  return `${JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: null, expiresAt: nowMs + YEAR_MS, scopes: ["user:inference"] } }, null, 2)}\n`;
}

export async function writeCredentials(dir: string, token: string, nowMs: number): Promise<void> {
  const file = path.join(dir, ".credentials.json");
  const temp = path.join(dir, `.credentials.json.${process.pid}.tmp`);
  await writeFile(temp, renderCredentials(token, nowMs), { mode: 0o600 });
  await rename(temp, file);
}
