/**
 * `/assets` is served `maxAge: 1y, immutable`, so a rebranded chunk must not
 * keep the file name a browser cached from an unbranded install. Every asset
 * gets `-<8 hex>` before its extension; the hex is the content hash of the
 * *rebranded* file plus the brand kit's hash, computed before references are
 * rewritten, so one pass yields every name and the result is reproducible.
 */
import { createHash } from "node:crypto";

export function hashContent(content, salt) {
  return createHash("sha256").update(content).update(salt).digest("hex").slice(0, 8);
}

function withSuffix(name, hash) {
  const dot = name.indexOf(".");
  return dot === -1 ? `${name}-${hash}` : `${name.slice(0, dot)}-${hash}${name.slice(dot)}`;
}

export function planRenames(entries) {
  const renames = new Map();
  const maps = [];
  for (const entry of entries) {
    if (entry.name.endsWith(".map")) maps.push(entry);
    else renames.set(entry.name, withSuffix(entry.name, entry.hash));
  }
  for (const entry of maps) {
    const owner = renames.get(entry.name.slice(0, -".map".length));
    renames.set(entry.name, owner ? `${owner}.map` : withSuffix(entry.name, entry.hash));
  }
  return renames;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function rewriteReferences(text, renames) {
  if (renames.size === 0) return { text, count: 0 };
  const names = [...renames.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const re = new RegExp(`(?<![A-Za-z0-9_.-])(?:${names.join("|")})(?![A-Za-z0-9_.-])`, "g");
  let count = 0;
  const out = text.replace(re, (name) => { count += 1; return renames.get(name); });
  return { text: out, count };
}
