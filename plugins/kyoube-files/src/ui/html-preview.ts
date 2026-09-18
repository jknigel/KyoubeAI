/**
 * Turning an HTML file from the project folder into something an iframe can
 * show as a page.
 *
 * The preview runs in `<iframe sandbox="allow-scripts allow-forms allow-modals">`
 * with this policy prepended, the same shape the apps plugin gives a published
 * app: an opaque origin (no cookies, no storage, no host DOM) and no network
 * at all (`default-src 'none'`, `connect-src 'none'`), so a page an agent wrote
 * can render and run its own inline script but cannot call out or navigate.
 */
export const PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";

/** Position just after a leading doctype, so the injected head keeps the document out of quirks mode. */
function afterDoctype(source: string): number {
  const match = /^[\t\n\f\r ]*<!doctype[^>]*>/i.exec(source);
  return match ? match[0].length : 0;
}

export function buildPreviewSrcdoc(html: string): string {
  const at = afterDoctype(html);
  return `${html.slice(0, at)}<head><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"></head>${html.slice(at)}`;
}

/** How many sibling files one preview may pull in; a page with more keeps the rest as-is. */
export const MAX_INLINED_ASSETS = 40;

export interface AssetLoader {
  /** Text of a sibling file (a stylesheet or script), or `null` when it cannot be read. */
  text(path: string): Promise<string | null>;
  /** A data: URL for a sibling image, or `null`. */
  dataUrl(path: string): Promise<string | null>;
}

const SKIP_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/**
 * Resolves an `href`/`src` against the folder of the HTML file, inside the
 * workspace: `./`, `../` and bare names are relative to the file; a leading `/`
 * means the workspace root; anything that would leave the root, and any
 * absolute URL, `data:` URL or fragment, is left for the browser (which, under
 * the policy above, means it is not loaded).
 */
export function resolveAssetPath(fileDir: string, url: string): string | null {
  const trimmed = url.trim().replace(/[?#].*$/, "");
  if (!trimmed || SKIP_URL.test(trimmed)) return null;
  const base = trimmed.startsWith("/") ? [] : fileDir ? fileDir.split("/") : [];
  const segments = [...base];
  for (const segment of trimmed.replace(/^\/+/, "").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

function escapeStyle(css: string): string {
  return css.replace(/<\/style/gi, "<\\/style");
}

function escapeScript(js: string): string {
  return js.replace(/<\/script/gi, "<\\/script");
}

/**
 * Inlines the stylesheets, scripts and images an HTML file references by
 * relative path — the way an agent writes a page next to its `style.css` and
 * a couple of images — so the sandboxed preview, which cannot fetch anything,
 * still shows the page as intended. Regex-based on purpose: this runs on
 * whatever an agent wrote, in the browser, and only ever *replaces* a tag
 * with an equivalent inline one, so a tag it does not recognise is simply
 * left alone. Anything not found or over budget stays as written.
 */
export async function inlineHtmlAssets(html: string, fileDir: string, loader: AssetLoader): Promise<string> {
  let budget = MAX_INLINED_ASSETS;
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const tagRe = /<(link|script|img)\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null) {
    if (budget === 0) break;
    const tag = match[0];
    const kind = match[1]!.toLowerCase();
    if (kind === "link") {
      const rel = attribute(tag, "rel");
      if (!rel || !/\bstylesheet\b/i.test(rel)) continue;
      const path = resolveAssetPath(fileDir, attribute(tag, "href") ?? "");
      if (!path) continue;
      budget -= 1;
      const css = await loader.text(path);
      if (css !== null) replacements.push({ start: match.index, end: match.index + tag.length, text: `<style>${escapeStyle(css)}</style>` });
    } else if (kind === "script") {
      const path = resolveAssetPath(fileDir, attribute(tag, "src") ?? "");
      if (!path) continue;
      // The script element's own content (usually empty) ends at the next </script>.
      const close = /<\/script\s*>/gi;
      close.lastIndex = match.index + tag.length;
      const closing = close.exec(html);
      if (!closing) continue;
      budget -= 1;
      const js = await loader.text(path);
      if (js !== null) replacements.push({ start: match.index, end: closing.index + closing[0].length, text: `<script>${escapeScript(js)}</script>` });
      tagRe.lastIndex = closing.index + closing[0].length;
    } else {
      const src = attribute(tag, "src");
      const path = resolveAssetPath(fileDir, src ?? "");
      if (!path || !src) continue;
      budget -= 1;
      const dataUrl = await loader.dataUrl(path);
      if (dataUrl !== null) {
        const srcRe = new RegExp(`(\\ssrc\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^\\s"'>]+)`, "i");
        replacements.push({ start: match.index, end: match.index + tag.length, text: tag.replace(srcRe, `$1"${dataUrl}"`) });
      }
    }
  }
  let out = "";
  let cursor = 0;
  for (const item of replacements) {
    out += html.slice(cursor, item.start) + item.text;
    cursor = item.end;
  }
  return out + html.slice(cursor);
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif",
};

export function imageMimeOf(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return null;
  return MIME_BY_EXTENSION[path.slice(dot + 1).toLowerCase()] ?? null;
}

export function isHtml(name: string): boolean {
  return /\.(html?|xhtml)$/i.test(name);
}

export function isSvg(name: string): boolean {
  return /\.svg$/i.test(name);
}
