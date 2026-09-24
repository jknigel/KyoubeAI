import { describe, expect, it } from "vitest";
import { hashContent, planRenames, rewriteReferences } from "../lib/assets.mjs";

describe("hashContent", () => {
  it("is 8 hex chars, stable, and salted", () => {
    expect(hashContent("abc", "kit1")).toMatch(/^[0-9a-f]{8}$/);
    expect(hashContent("abc", "kit1")).toBe(hashContent("abc", "kit1"));
    expect(hashContent("abc", "kit1")).not.toBe(hashContent("abc", "kit2"));
    expect(hashContent(Buffer.from("abc"), "kit1")).toBe(hashContent("abc", "kit1"));
  });
});

describe("planRenames", () => {
  it("suffixes every asset and keeps a .map on its .js", () => {
    const renames = planRenames([
      { name: "index-BHbrFFmp.js", hash: "aaaaaaaa" },
      { name: "index-BHbrFFmp.js.map", hash: "ffffffff" },
      { name: "index-BU41-p9M.css", hash: "bbbbbbbb" },
      { name: "CompanyExport-Z_xz3qVA.js", hash: "cccccccc" },
    ]);
    expect(renames.get("index-BHbrFFmp.js")).toBe("index-BHbrFFmp-aaaaaaaa.js");
    expect(renames.get("index-BHbrFFmp.js.map")).toBe("index-BHbrFFmp-aaaaaaaa.js.map");
    expect(renames.get("index-BU41-p9M.css")).toBe("index-BU41-p9M-bbbbbbbb.css");
    expect(renames.get("CompanyExport-Z_xz3qVA.js")).toBe("CompanyExport-Z_xz3qVA-cccccccc.js");
  });

  it("gives an orphan .map its own suffix", () => {
    const renames = planRenames([{ name: "lonely-AAAAAAAA.js.map", hash: "12345678" }]);
    expect(renames.get("lonely-AAAAAAAA.js.map")).toBe("lonely-AAAAAAAA-12345678.js.map");
  });

  it("never renames a file twice or a file without an extension", () => {
    const renames = planRenames([{ name: "README", hash: "12345678" }]);
    expect(renames.get("README")).toBe("README-12345678");
  });
});

describe("rewriteReferences", () => {
  const renames = new Map([
    ["index-BHbrFFmp.js", "index-BHbrFFmp-aaaaaaaa.js"],
    ["index-BHbrFFmp.js.map", "index-BHbrFFmp-aaaaaaaa.js.map"],
    ["CompanyExport-Z_xz3qVA.js", "CompanyExport-Z_xz3qVA-cccccccc.js"],
  ]);

  it("rewrites html, dynamic imports and source-map comments", () => {
    const html = '<script type="module" crossorigin src="/assets/index-BHbrFFmp.js"></script>';
    expect(rewriteReferences(html, renames).text).toBe('<script type="module" crossorigin src="/assets/index-BHbrFFmp-aaaaaaaa.js"></script>');
    const js = 'import("./CompanyExport-Z_xz3qVA.js");\n//# sourceMappingURL=index-BHbrFFmp.js.map';
    const out = rewriteReferences(js, renames);
    expect(out.text).toBe('import("./CompanyExport-Z_xz3qVA-cccccccc.js");\n//# sourceMappingURL=index-BHbrFFmp-aaaaaaaa.js.map');
    expect(out.count).toBe(2);
  });

  it("does not touch a longer name that merely contains an old name", () => {
    expect(rewriteReferences("xindex-BHbrFFmp.js", renames).text).toBe("xindex-BHbrFFmp.js");
    expect(rewriteReferences("index-BHbrFFmp.jsx", renames).text).toBe("index-BHbrFFmp.jsx");
  });

  it("does not treat a dot as a boundary: an extensionless name never rewrites a dotted name it prefixes", () => {
    const withPlain = new Map([...renames, ["manifest", "manifest-12345678"]]);
    expect(rewriteReferences('"manifest.json" and "manifest"', withPlain).text).toBe('"manifest.json" and "manifest-12345678"');
    expect(rewriteReferences("a.manifest", withPlain).text).toBe("a.manifest");
  });
});
