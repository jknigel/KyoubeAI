/** Bytes as a short human figure: `0 B`, `12 KB`, `1.5 MB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)} ${units[unit]}`;
}

/** A modification time relative to now (`just now`, `5 min ago`, `2 h ago`, `3 d ago`), or the date when older. */
export function formatWhen(mtimeMs: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - mtimeMs) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(mtimeMs).toISOString().slice(0, 10);
}

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The image MIME type for a file name the browser can show inline, else `null`. */
export function imageTypeOf(name: string): string | null {
  return IMAGE_TYPES[extensionOf(name)] ?? null;
}

export function isMarkdown(name: string): boolean {
  const ext = extensionOf(name);
  return ext === "md" || ext === "markdown" || ext === "mdx";
}

/** The breadcrumb segments for a canonical relative path: `[["", "root"], ["a", "a"], ["a/b", "b"]]`. */
export function breadcrumbs(path: string): Array<{ path: string; name: string }> {
  const out: Array<{ path: string; name: string }> = [];
  if (!path) return out;
  let acc = "";
  for (const segment of path.split("/")) {
    acc = acc ? `${acc}/${segment}` : segment;
    out.push({ path: acc, name: segment });
  }
  return out;
}

export function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** Bytes → base64, chunked so a multi-megabyte upload does not blow the argument list of `String.fromCharCode`. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
