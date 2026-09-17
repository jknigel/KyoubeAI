import { describe, expect, it } from "vitest";
import {
  THINKING_PATH_LENGTH, jsxProps, markPathFrom, parseSvgElements, renderFaviconSvg, renderManifest,
  renderThinkingSvg, replaceLockup, replaceThinkingIcon,
} from "../lib/svg.mjs";

const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M6 4v16M18 4l-11 8 11 8"/>
</svg>`;
const LOCKUP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 124 28" fill="currentColor">
  <path d="M6 4v16M18 4l-11 8 11 8" transform="translate(0 2)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="30" y="21" font-family="Inter, system-ui, sans-serif" font-weight="600" font-size="19" letter-spacing="-0.02em">KyoubeAI</text>
</svg>`;

// The exact minified shape upstream 2026.831.1 ships (two of its ten paths, shortened).
const UPSTREAM_LOCKUP = 'function DXn({decorative:e=!1,title:t="Paperclip",className:n,...r}){return(0,s.jsxs)("svg",{...r,className:n,viewBox:"22.5 22.5 121 27",fill:"currentColor",role:e?void 0:"img","aria-hidden":e?!0:void 0,"aria-label":e?void 0:t,focusable:"false",children:[(0,s.jsx)("path",{d:"M131.15 48.4902V31.9902H133.922Z"}),(0,s.jsx)("path",{d:"M46.2611 33.6556L34.7307 44.6408Z"})]})}';
const UPSTREAM_THINKING = 'function VXn({className:e,...t}){return(0,s.jsx)("svg",{viewBox:"-1 -1 26 26",className:U("paperclip-thinking-icon",e),"aria-hidden":"true",...t,children:(0,s.jsx)("path",{className:"paperclip-thinking-icon-path",d:"M16 6 l-8.414 8.586 a2.000 2.000 0 0 0 2.828 2.828",fill:"none",stroke:"currentColor",strokeWidth:"2",strokeLinecap:"round",strokeLinejoin:"round"})})}';

describe("parseSvgElements / markPathFrom / jsxProps", () => {
  it("reads the viewBox and the path/text children with their attributes", () => {
    const lockup = parseSvgElements(LOCKUP);
    expect(lockup.viewBox).toBe("0 0 124 28");
    expect(lockup.elements.map((e) => e.tag)).toEqual(["path", "text"]);
    expect(lockup.elements[0].attrs.d).toBe("M6 4v16M18 4l-11 8 11 8");
    expect(lockup.elements[0].attrs["stroke-width"]).toBe("2");
    expect(lockup.elements[1].text).toBe("KyoubeAI");
  });

  it("markPathFrom returns the single d and rejects anything else", () => {
    expect(markPathFrom(MARK)).toBe("M6 4v16M18 4l-11 8 11 8");
    expect(() => markPathFrom(MARK.replace("</svg>", '<path d="M0 0"/></svg>'))).toThrow(/exactly one/);
  });

  it("jsxProps converts SVG attribute names to React props and quotes values", () => {
    expect(jsxProps({ d: "M0 0", "stroke-width": "2", "font-family": "Inter, x", "stroke-linecap": "round", transform: "translate(0 2)" }))
      .toBe('{d:"M0 0",strokeWidth:"2",fontFamily:"Inter, x",strokeLinecap:"round",transform:"translate(0 2)"}');
    expect(jsxProps({ x: "30" }, { children: "KyoubeAI" })).toBe('{x:"30",children:"KyoubeAI"}');
  });
});

describe("replaceLockup", () => {
  it("swaps the viewBox and the path-only children for the kit's mark and wordmark, through the same jsx helper", () => {
    const { text, matches } = replaceLockup(UPSTREAM_LOCKUP, parseSvgElements(LOCKUP));
    expect(matches).toBe(1);
    expect(text).toContain('viewBox:"0 0 124 28"');
    expect(text).not.toContain("M131.15");
    expect(text).toContain('(0,s.jsx)("path",{d:"M6 4v16M18 4l-11 8 11 8",transform:"translate(0 2)",fill:"none",stroke:"currentColor",strokeWidth:"2",strokeLinecap:"round",strokeLinejoin:"round"})');
    expect(text).toContain('(0,s.jsx)("text",{x:"30",y:"21",fontFamily:"Inter, system-ui, sans-serif",fontWeight:"600",fontSize:"19",letterSpacing:"-0.02em",children:"KyoubeAI"})');
    // Everything around the children array is untouched: the aria wiring still reads the title prop.
    expect(text).toContain('"aria-label":e?void 0:t,focusable:"false",children:[');
    expect(text.endsWith("]})}")).toBe(true);
  });

  it("reports 0 matches on a file without the anchor and 2 on a doubled one", () => {
    expect(replaceLockup("nothing", parseSvgElements(LOCKUP)).matches).toBe(0);
    expect(replaceLockup(UPSTREAM_LOCKUP + UPSTREAM_LOCKUP, parseSvgElements(LOCKUP)).matches).toBe(2);
  });
});

describe("replaceThinkingIcon", () => {
  it("replaces the animated path and pins pathLength so upstream's dash keyframes still draw the whole mark", () => {
    const { text, matches } = replaceThinkingIcon(UPSTREAM_THINKING, "M6 4v16M18 4l-11 8 11 8");
    expect(matches).toBe(1);
    expect(text).toContain(`className:"paperclip-thinking-icon-path",d:"M6 4v16M18 4l-11 8 11 8",pathLength:"${THINKING_PATH_LENGTH}",fill:"none"`);
    expect(text).not.toContain("M16 6 l-8.414");
  });
});

describe("renderFaviconSvg / renderThinkingSvg", () => {
  it("favicon keeps upstream's theme-aware stroke colours around the mark", () => {
    const svg = renderFaviconSvg("M6 4v16");
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain("prefers-color-scheme: dark");
    expect(svg).toContain('d="M6 4v16"');
    expect(svg).not.toContain("8.414");
  });

  it("thinking svg keeps the keyframes and pins pathLength", () => {
    const svg = renderThinkingSvg("M6 4v16");
    expect(svg).toContain("@keyframes draw");
    expect(svg).toContain("stroke-dasharray:0.000 85.717");
    expect(svg).toContain(`pathLength="${THINKING_PATH_LENGTH}"`);
    expect(svg).toContain('d="M6 4v16"');
  });
});

describe("renderManifest", () => {
  it("rewrites the names, description and colours and keeps the icon entries", () => {
    const upstream = JSON.stringify({ id: "/", name: "Paperclip", short_name: "Paperclip", description: "x", theme_color: "#000", background_color: "#000", icons: [{ src: "/android-chrome-192x192.png", sizes: "192x192", type: "image/png" }] });
    const out = JSON.parse(renderManifest(upstream, { name: "KyoubeAI", shortName: "KyoubeAI", description: "AI OS", themeColor: "#18181b" }));
    expect(out).toMatchObject({ id: "/", name: "KyoubeAI", short_name: "KyoubeAI", description: "AI OS", theme_color: "#18181b", background_color: "#18181b" });
    expect(out.icons).toHaveLength(1);
  });
});
