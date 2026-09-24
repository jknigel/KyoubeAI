/**
 * The two SVGs that live *inside* the minified UI bundle (the sign-in lockup and
 * the loading animation) and the three static SVG/JSON artwork files. Anchored
 * on strings upstream's build does not minify (attribute values), never on
 * minified identifiers; the jsx helper name is captured from the match.
 */

/** Upstream's paperclip path length, hard-coded in its dash keyframes; pathLength normalises our mark to it. */
export const THINKING_PATH_LENGTH = "85.717";

const ELEMENT_RE = /<(path|text)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;
const ATTR_RE = /([A-Za-z:-]+)="([^"]*)"/g;

export function parseSvgElements(svg) {
  const viewBox = /<svg\b[^>]*\bviewBox="([^"]+)"/.exec(svg)?.[1];
  if (!viewBox) throw new Error("svg has no viewBox");
  const elements = [];
  for (const match of svg.matchAll(ELEMENT_RE)) {
    const attrs = {};
    for (const attr of match[2].matchAll(ATTR_RE)) attrs[attr[1]] = attr[2];
    elements.push({ tag: match[1], attrs, text: match[3] === undefined ? null : match[3].trim() });
  }
  return { viewBox, elements };
}

export function markPathFrom(markSvg) {
  const paths = parseSvgElements(markSvg).elements.filter((e) => e.tag === "path");
  if (paths.length !== 1 || !paths[0].attrs.d) throw new Error(`mark.svg must contain exactly one <path> with a d attribute, found ${paths.length}`);
  return paths[0].attrs.d;
}

const toProp = (name) => (name === "viewBox" ? name : name.replace(/-([a-z])/g, (_, c) => c.toUpperCase()));

export function jsxProps(attrs, extra = {}) {
  const entries = Object.entries(attrs).filter(([name]) => name !== "class" && name !== "xmlns");
  const parts = entries.map(([name, value]) => `${toProp(name)}:${JSON.stringify(value)}`);
  for (const [name, value] of Object.entries(extra)) parts.push(`${name}:${JSON.stringify(value)}`);
  return `{${parts.join(",")}}`;
}

// `viewBox:"22.5 22.5 121 27"`, then the remaining attributes (no brackets in
// them), then a children array made only of ("path",{d:"…"}) elements.
const LOCKUP_RE = /viewBox:"22\.5 22\.5 121 27"([^[\]]{0,600}?)children:\[((?:\(0,([A-Za-z_$][\w$]*)\.jsx\)\("path",\{d:"[^"]*"\}\),?)+)\]/g;

export function replaceLockup(js, lockup) {
  let matches = 0;
  const text = js.replace(LOCKUP_RE, (_all, between, _children, helper) => {
    matches += 1;
    const children = lockup.elements.map((el) => {
      const extra = el.tag === "text" && el.text !== null ? { children: el.text } : {};
      return `(0,${helper}.jsx)(${JSON.stringify(el.tag)},${jsxProps(el.attrs, extra)})`;
    });
    return `viewBox:${JSON.stringify(lockup.viewBox)}${between}children:[${children.join(",")}]`;
  });
  return { text, matches };
}

const THINKING_RE = /className:"paperclip-thinking-icon-path",d:"[^"]*"/g;

export function replaceThinkingIcon(js, markD) {
  let matches = 0;
  const text = js.replace(THINKING_RE, () => {
    matches += 1;
    return `className:"paperclip-thinking-icon-path",d:${JSON.stringify(markD)},pathLength:${JSON.stringify(THINKING_PATH_LENGTH)}`;
  });
  return { text, matches };
}

export function renderFaviconSvg(markD) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">
  <style>
    path { stroke: #18181b; }
    @media (prefers-color-scheme: dark) {
      path { stroke: #e4e4e7; }
    }
  </style>
  <path stroke-width="2" d="${markD}"/>
</svg>
`;
}

export function renderThinkingSvg(markD) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="-1.00 -1.00 26.00 26.00"
     style="transform:rotate(0deg);transform-origin:50% 50%;">
  <defs></defs>
  <style>
    @keyframes draw {
  0%          { stroke-dasharray:0.000 85.717; stroke-dashoffset:-85.717; opacity:1; animation-timing-function:cubic-bezier(0.455, 0.03, 0.515, 0.955); }
  39.0625%      { stroke-dasharray:85.717 85.717; stroke-dashoffset:0.000; opacity:1; animation-timing-function:cubic-bezier(0.55, 0.055, 0.675, 0.19); }
  78.1250%      { stroke-dasharray:0.000 85.717; stroke-dashoffset:0.000; opacity:1; }
  78.2250%  { opacity:0; }
  100%        { stroke-dasharray:0.000 85.717; stroke-dashoffset:0.000; opacity:0; }
}
    .p { animation: draw 1s linear infinite; }
  </style>
  <path class="p" d="${markD}" pathLength="${THINKING_PATH_LENGTH}" fill="none" stroke="#ffffff"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;
}

export function renderManifest(upstreamJson, brand) {
  const manifest = JSON.parse(upstreamJson);
  manifest.name = brand.name;
  manifest.short_name = brand.shortName;
  manifest.description = brand.description;
  manifest.theme_color = brand.themeColor;
  manifest.background_color = brand.themeColor;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
