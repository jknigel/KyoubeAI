import { DataError } from "../data/errors.js";

/** A group's data level. Never "none": the browser-trusted Data reads assume every member can read (SECURITY.md). */
export const GROUP_LEVELS = ["read", "write", "schema"] as const;
export type GroupLevel = (typeof GROUP_LEVELS)[number];

export function parseGroupLevel(value: unknown): GroupLevel | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" && (GROUP_LEVELS as readonly string[]).includes(value)) return value as GroupLevel;
  throw new DataError("invalid", `a group's data level must be one of ${GROUP_LEVELS.join(", ")} or empty`);
}

export function highestLevel(levels: GroupLevel[]): GroupLevel {
  return levels.reduce((best, level) => (GROUP_LEVELS.indexOf(level) > GROUP_LEVELS.indexOf(best) ? level : best));
}

/**
 * Ruling R19: the core refuses every non-GET request from a viewer ("Viewer access is read-only"),
 * plugin actions and writes included, so a group can never raise a viewer above `read`.
 */
export function isViewerRole(role: string | null | undefined): boolean {
  return (role ?? "").toLowerCase() === "viewer";
}

/**
 * Where a person's data level comes from, for the Data access people table. Owners and admins are
 * exempt from groups, and a viewer cannot be raised (ruling R19), so both always show their role.
 */
export function levelSource(role: string | null | undefined, levelledGroups: string[]): string {
  if (isViewerRole(role)) return "role: viewer (groups cannot raise a viewer)";
  if (!isManagerRole(role) && levelledGroups.length > 0) return `group: ${levelledGroups.join(", ")}`;
  return `role: ${role ?? "none"}`;
}

/** The roles groups never restrict: they are the people who manage groups. */
export function isManagerRole(role: string | null | undefined): boolean {
  const value = (role ?? "").toLowerCase();
  return value === "owner" || value === "admin";
}
