import { describe, expect, it } from "vitest";
import { buildPreviewSrcdoc, imageMimeOf, inlineHtmlAssets, isHtml, isSvg, MAX_INLINED_ASSETS, PREVIEW_CSP, resolveAssetPath, type AssetLoader } from "../src/ui/html-preview.js";

describe("buildPreviewSrcdoc", () => {
  it("prepends the policy after a leading doctype, or first otherwise", () => {
    expect(buildPreviewSrcdoc("<!doctype html><html><body>x</body></html>")).toBe(`<!doctype html><head><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"></head><html><body>x</body></html>`);
    expect(buildPreviewSrcdoc("<p>bare</p>")).toBe(`<head><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"></head><p>bare</p>`);
  });
  it("forbids every network channel", () => {
    expect(PREVIEW_CSP).toContain("default-src 'none'");
    expect(PREVIEW_CSP).toContain("connect-src 'none'");
    expect(PREVIEW_CSP).toContain("form-action 'none'");
    expect(PREVIEW_CSP).toContain("base-uri 'none'");
    expect(PREVIEW_CSP).not.toContain("unsafe-eval");
  });
});

describe("resolveAssetPath", () => {
  it("resolves relative references against the page's folder, inside the workspace", () => {
    expect(resolveAssetPath("site", "style.css")).toBe("site/style.css");
    expect(resolveAssetPath("site", "./img/a.png?v=2#x")).toBe("site/img/a.png");
    expect(resolveAssetPath("site/pages", "../shared.css")).toBe("site/shared.css");
    expect(resolveAssetPath("", "a.js")).toBe("a.js");
    expect(resolveAssetPath("site", "/root.css")).toBe("root.css");
  });
  it("leaves absolute URLs, data URLs, fragments and escapes alone", () => {
    expect(resolveAssetPath("site", "https://cdn.example.com/x.js")).toBeNull();
    expect(resolveAssetPath("site", "//cdn.example.com/x.js")).toBeNull();
    expect(resolveAssetPath("site", "data:image/png;base64,AAAA")).toBeNull();
    expect(resolveAssetPath("site", "#top")).toBeNull();
    expect(resolveAssetPath("site", "../../etc/passwd")).toBeNull();
    expect(resolveAssetPath("", "")).toBeNull();
  });
});

function loader(files: Record<string, string>): AssetLoader & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    text: async (path) => { asked.push(path); return files[path] ?? null; },
    dataUrl: async (path) => { asked.push(path); return path in files ? `data:${imageMimeOf(path)};base64,${Buffer.from(files[path]!).toString("base64")}` : null; },
  };
}

describe("inlineHtmlAssets", () => {
  it("inlines a stylesheet, a script and an image referenced by relative path", async () => {
    const html = `<!doctype html><html><head><link rel="stylesheet" href="style.css"><script src="app.js"></script></head><body><img alt="logo" src='img/logo.png' width=10></body></html>`;
    const out = await inlineHtmlAssets(html, "site", loader({ "site/style.css": "body{color:red}", "site/app.js": "console.log(1)", "site/img/logo.png": "PNG" }));
    expect(out).toContain("<style>body{color:red}</style>");
    expect(out).toContain("<script>console.log(1)</script>");
    expect(out).toContain(`<img alt="logo" src="data:image/png;base64,${Buffer.from("PNG").toString("base64")}" width=10>`);
    expect(out).not.toContain("style.css");
    expect(out).not.toContain("app.js");
  });
  it("leaves tags whose file is missing, absolute, or not an asset untouched", async () => {
    const html = `<link rel="icon" href="fav.ico"><link rel="stylesheet" href="https://x/y.css"><script src="missing.js"></script><img src="data:image/gif;base64,R0lG"><img src="nope.png"><script>inline()</script>`;
    const l = loader({});
    const out = await inlineHtmlAssets(html, "", l);
    expect(out).toBe(html);
    expect(l.asked).toEqual(["missing.js", "nope.png"]);
  });
  it("neutralises a closing tag inside inlined text", async () => {
    const out = await inlineHtmlAssets(`<link rel=stylesheet href=a.css><script src=b.js></script>`, "", loader({ "a.css": "x{} </style><b>", "b.js": "s='</script>'" }));
    expect(out).toBe(`<style>x{} <\\/style><b></style><script>s='<\\/script>'</script>`);
  });
  it("stops after the asset budget", async () => {
    const tags = Array.from({ length: MAX_INLINED_ASSETS + 5 }, (_, i) => `<img src="i${i}.png">`).join("");
    const l = loader({});
    await inlineHtmlAssets(tags, "", l);
    expect(l.asked).toHaveLength(MAX_INLINED_ASSETS);
  });
});

describe("name classification", () => {
  it("recognises html and svg", () => {
    expect(isHtml("index.HTML")).toBe(true);
    expect(isHtml("page.htm")).toBe(true);
    expect(isHtml("page.html.bak")).toBe(false);
    expect(isSvg("logo.svg")).toBe(true);
    expect(imageMimeOf("a/b.JPG")).toBe("image/jpeg");
    expect(imageMimeOf("a/b.txt")).toBeNull();
  });
});
