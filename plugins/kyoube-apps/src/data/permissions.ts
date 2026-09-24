import { DataError } from "./errors.js";

export type AccessLevel = "none" | "read" | "write" | "schema";
export type Operation = "read" | "write" | "schema";
export const ACCESS_LEVELS: readonly AccessLevel[] = ["none", "read", "write", "schema"];

export interface DataActor {
  kind: "user" | "agent" | "system";
  id: string | null;
  runId?: string | null;
}

export function parseLevel(value: unknown): AccessLevel {
  if (typeof value === "string" && (ACCESS_LEVELS as readonly string[]).includes(value)) return value as AccessLevel;
  throw new DataError("invalid", `access level must be one of ${ACCESS_LEVELS.join(", ")}`);
}

export function levelAllows(level: AccessLevel, op: Operation): boolean {
  return ACCESS_LEVELS.indexOf(level) >= ACCESS_LEVELS.indexOf(op);
}

export function roleToLevel(role: string | null | undefined): AccessLevel {
  switch ((role ?? "").toLowerCase()) {
    case "owner": case "admin": return "schema";
    case "operator": case "member": return "write";
    case "viewer": return "read";
    default: return "none";
  }
}

export function assertLevel(level: AccessLevel, op: Operation, what: string): void {
  if (!levelAllows(level, op)) {
    throw new DataError("forbidden", `${what} requires ${op} access (you have ${level})`);
  }
}
