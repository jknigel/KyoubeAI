export interface TerminalSettings {
  idleTimeoutMinutes: number;
  maxSessionsPerUser: number;
  allowedRoles: string[];
  shell: string;
  scrollbackKb: number;
}

export const DEFAULT_SETTINGS: TerminalSettings = {
  idleTimeoutMinutes: 30,
  maxSessionsPerUser: 3,
  allowedRoles: ["owner", "admin"],
  shell: "/bin/bash",
  scrollbackKb: 256,
};

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function resolveSettings(raw: Record<string, unknown> | null | undefined): TerminalSettings {
  const source = raw ?? {};
  const roles = Array.isArray(source.allowedRoles)
    ? source.allowedRoles
        .filter((role): role is string => typeof role === "string" && role.trim().length > 0)
        .map((role) => role.trim().toLowerCase())
    : DEFAULT_SETTINGS.allowedRoles;
  return {
    idleTimeoutMinutes: positiveNumber(source.idleTimeoutMinutes, DEFAULT_SETTINGS.idleTimeoutMinutes),
    maxSessionsPerUser: positiveNumber(source.maxSessionsPerUser, DEFAULT_SETTINGS.maxSessionsPerUser),
    allowedRoles: roles.length > 0 ? roles : DEFAULT_SETTINGS.allowedRoles,
    shell: typeof source.shell === "string" && source.shell.startsWith("/") ? source.shell : DEFAULT_SETTINGS.shell,
    scrollbackKb: positiveNumber(source.scrollbackKb, DEFAULT_SETTINGS.scrollbackKb),
  };
}
