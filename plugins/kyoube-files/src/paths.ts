import { posix } from "node:path";
import { FilesError } from "./errors.js";

/**
 * Normalises a caller-supplied path relative to a workspace root into the
 * canonical `a/b/c` form (no leading or trailing slash, `""` for the root
 * itself). Anything that could name something outside the root is refused
 * here, before the filesystem is touched: an absolute path, a `..` segment
 * that survives normalisation, a NUL byte, or a backslash (a Windows
 * separator would be a plain character on Linux, but a caller sending one is
 * never doing what they meant). Symlinks are handled separately, by the
 * realpath check in `WorkspaceFiles`, because they can only be seen on disk.
 */
export function normalizeRelativePath(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new FilesError("invalid", "path must be a string");
  if (value.includes("\0")) throw new FilesError("invalid", "path must not contain NUL");
  if (value.includes("\\")) throw new FilesError("invalid", "path must use forward slashes");
  if (value.startsWith("/")) throw new FilesError("invalid", "path must be relative to the project folder");
  const normalized = posix.normalize(value).replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (normalized === "." || normalized === "") return "";
  for (const segment of normalized.split("/")) {
    if (segment === "..") throw new FilesError("invalid", "path must stay inside the project folder");
    if (segment === "." || segment === "") throw new FilesError("invalid", "path has an empty segment");
  }
  return normalized;
}

/** A single new file or folder name: one segment, no separators, not `.`/`..`. */
export function validateEntryName(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new FilesError("invalid", "name is required");
  if (value.length > 255) throw new FilesError("invalid", "name must be at most 255 characters");
  if (value.includes("/") || value.includes("\\") || value.includes("\0")) throw new FilesError("invalid", "name must not contain a path separator");
  if (value === "." || value === "..") throw new FilesError("invalid", "name must not be . or ..");
  if (value.trim() !== value) throw new FilesError("invalid", "name must not start or end with whitespace");
  return value;
}

export function joinRelative(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export function parentOf(relative: string): string {
  const index = relative.lastIndexOf("/");
  return index === -1 ? "" : relative.slice(0, index);
}

export function baseName(relative: string): string {
  const index = relative.lastIndexOf("/");
  return index === -1 ? relative : relative.slice(index + 1);
}

/** Whether `child` is `parent` itself or lives under it (both canonical relative paths). */
export function isWithin(parent: string, child: string): boolean {
  if (parent === "") return true;
  return child === parent || child.startsWith(`${parent}/`);
}

const TEXT_PROBE_BYTES = 8 * 1024;

/**
 * Text or binary: a NUL byte in the first 8 KiB, or bytes that are not valid
 * UTF-8, mean binary. Extensions are deliberately not consulted — an agent's
 * `.log` or `.dat` file is text if its bytes are.
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  const probe = bytes.subarray(0, TEXT_PROBE_BYTES);
  for (const byte of probe) if (byte === 0) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
