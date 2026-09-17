import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BRAND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../brand");
const read = (name) => readFile(path.join(BRAND, name), "utf8");

describe("docker/brand", () => {
  it("brand.json carries every field the transform reads", async () => {
    const brand = JSON.parse(await read("brand.json"));
    expect(brand.name).toBe("KyoubeAI");
    expect(typeof brand.shortName).toBe("string");
    expect(typeof brand.description).toBe("string");
    expect(brand.themeColor).toMatch(/^#[0-9a-f]{6}$/);
    for (const key of ["home", "docs", "feedback", "tos", "repo"]) expect(brand.urls[key]).toMatch(/^https:\/\//);
    expect(typeof brand.phrases).toBe("object");
  });

  it("mark.svg is a single stroked path in a 24×24 box", async () => {
    const svg = await read("mark.svg");
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect([...svg.matchAll(/<path\b/g)]).toHaveLength(1);
    expect(svg).not.toMatch(/<(rect|circle|text|g)\b/);
  });

  it("lockup.svg is one path and one text element", async () => {
    const svg = await read("lockup.svg");
    expect(svg).toMatch(/viewBox="0 0 \d+ \d+"/);
    expect([...svg.matchAll(/<path\b/g)]).toHaveLength(1);
    expect([...svg.matchAll(/<text\b/g)]).toHaveLength(1);
    expect(svg).toContain(">KyoubeAI</text>");
  });

  it("the six icon files are committed and non-empty", async () => {
    for (const name of ["favicon.ico", "favicon-16x16.png", "favicon-32x32.png", "apple-touch-icon.png", "android-chrome-192x192.png", "android-chrome-512x512.png"]) {
      const bytes = await readFile(path.join(BRAND, "icons", name));
      expect(bytes.length, name).toBeGreaterThan(100);
    }
  });
});
