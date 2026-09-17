#!/usr/bin/env node
/**
 * Renders the committed brand icons from docker/brand/mark.svg. Run it after
 * changing the mark; the outputs are committed so the image build needs no
 * rasteriser. PNG icons get a rounded dark plate behind a light stroke so they
 * read on any launcher background; the SVG favicon stays theme-aware (Task 3).
 *
 *   node scripts/render-brand-icons.mjs
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRAND = path.join(ROOT, "docker", "brand");
const ICONS = path.join(BRAND, "icons");

/** The single path the mark is made of; the renderer and the transform both key on it. */
export function markPath(markSvg) {
  const paths = [...markSvg.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map((m) => m[1]);
  if (paths.length !== 1) throw new Error(`mark.svg must contain exactly one <path>, found ${paths.length}`);
  return paths[0];
}

/** A plate + stroke composition sized for launchers; `size` is the output pixel size. */
function plateSvg(d, size, brand) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
<rect width="24" height="24" rx="5" fill="${brand.themeColor}"/>
<path d="${d}" fill="none" stroke="#e4e4e7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

function renderPng(svg, size) {
  return new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
}

/** ICO container holding one PNG entry (valid since Windows Vista; every browser reads it). */
export function pngToIco(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0);
  entry.writeUInt8(size >= 256 ? 0 : size, 1);
  entry.writeUInt8(0, 2); // palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12); // offset: header + one entry
  return Buffer.concat([header, entry, png]);
}

async function main() {
  const brand = JSON.parse(await readFile(path.join(BRAND, "brand.json"), "utf8"));
  const d = markPath(await readFile(path.join(BRAND, "mark.svg"), "utf8"));
  await mkdir(ICONS, { recursive: true });
  const outputs = [
    ["favicon-16x16.png", 16],
    ["favicon-32x32.png", 32],
    ["apple-touch-icon.png", 180],
    ["android-chrome-192x192.png", 192],
    ["android-chrome-512x512.png", 512],
  ];
  for (const [name, size] of outputs) {
    await writeFile(path.join(ICONS, name), renderPng(plateSvg(d, size, brand), size));
    console.log(`wrote icons/${name}`);
  }
  await writeFile(path.join(ICONS, "favicon.ico"), pngToIco(renderPng(plateSvg(d, 48, brand), 48), 48));
  console.log("wrote icons/favicon.ico");
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) await main();
