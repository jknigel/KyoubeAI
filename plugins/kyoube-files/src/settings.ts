export interface FilesSettings {
  readRoles: string[];
  writeRoles: string[];
  maxEditableKb: number;
  maxUploadMb: number;
  maxDownloadMb: number;
}

export const DEFAULT_SETTINGS: FilesSettings = {
  readRoles: ["owner", "admin", "operator", "member", "viewer"],
  writeRoles: ["owner", "admin", "operator", "member"],
  maxEditableKb: 1024,
  maxUploadMb: 5,
  maxDownloadMb: 25,
};

/**
 * The core's JSON body limit is 10 MB (`DEFAULT_JSON_BODY_LIMIT`, upstream
 * `server/src/http/body-limits.ts`), and an upload travels base64-encoded inside
 * a JSON action body, so anything above ~7 MiB raw can never reach the worker.
 * A larger configured value is clamped rather than honoured, so the limit the
 * UI shows is one that actually works.
 */
export const MAX_UPLOAD_MB = 7;

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function roleList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const roles = value
    .filter((role): role is string => typeof role === "string" && role.trim().length > 0)
    .map((role) => role.trim().toLowerCase());
  return roles.length > 0 ? roles : fallback;
}

export function resolveSettings(raw: Record<string, unknown> | null | undefined): FilesSettings {
  const source = raw ?? {};
  return {
    readRoles: roleList(source.readRoles, DEFAULT_SETTINGS.readRoles),
    writeRoles: roleList(source.writeRoles, DEFAULT_SETTINGS.writeRoles),
    maxEditableKb: positiveNumber(source.maxEditableKb, DEFAULT_SETTINGS.maxEditableKb),
    maxUploadMb: Math.min(MAX_UPLOAD_MB, positiveNumber(source.maxUploadMb, DEFAULT_SETTINGS.maxUploadMb)),
    maxDownloadMb: positiveNumber(source.maxDownloadMb, DEFAULT_SETTINGS.maxDownloadMb),
  };
}
