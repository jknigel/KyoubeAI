import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SIDEBAR_ORDER } from "../src/manifest.js";
import { WORKSPACE_GROUPS } from "../src/ui/links.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("the Workspace page", () => {
  const routes = WORKSPACE_GROUPS.flatMap((group) => group.cards.map((card) => card.to));

  it("has a card for every link the theme hides from the sidebar", async () => {
    // @ts-expect-error -- plain ES module outside this package
    const { SECTIONS } = await import("../../../docker/theme/anchors.mjs");
    // Every section the skin hides whole is declared "exact" in anchors.mjs.
    const hidden = SECTIONS.filter((section: { mode: string }) => section.mode === "exact").flatMap((section: { expected: string[] }) => section.expected);
    expect(hidden.length).toBeGreaterThan(0);
    const hiddenElsewhere = ["/artifacts", "/skills", "/terminal"];
    // A card covers a route when it links it or a page under it (All agents covers /agents).
    const covered = (route: string) => routes.some((to) => to === route || to.startsWith(`${route}/`));
    expect([...hidden, ...hiddenElsewhere].filter((route: string) => !covered(route))).toEqual([]);
  });

  it("links the core's canonical routes, not the ones it only redirects", () => {
    // Core 2026.916 folded the org chart into All agents and moved timeline and costs under Audit.
    expect(routes.filter((to) => ["/org", "/timeline", "/costs"].includes(to))).toEqual([]);
  });

  it("never lists the same card twice", () => {
    const ids = WORKSPACE_GROUPS.flatMap((group) => group.cards.map((card) => card.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("sidebar order", () => {
  it("matches the order the Data, Apps and Terminal links declare in their own manifests", () => {
    const apps = readFileSync(path.join(ROOT, "plugins/kyoube-apps/src/manifest.ts"), "utf8");
    const terminal = readFileSync(path.join(ROOT, "plugins/kyoube-terminal/src/manifest.ts"), "utf8");
    expect(apps).toMatch(new RegExp(`id: "data-nav",[^}]*order: ${SIDEBAR_ORDER.data} }`));
    expect(apps).toMatch(new RegExp(`id: "apps-nav",[^}]*order: ${SIDEBAR_ORDER.apps} }`));
    expect(terminal).toMatch(new RegExp(`id: "terminal-nav",[^}]*order: ${SIDEBAR_ORDER.terminal} }`));
    expect(SIDEBAR_ORDER.build).toBeLessThan(SIDEBAR_ORDER.data);
    expect(SIDEBAR_ORDER.apps).toBeLessThan(SIDEBAR_ORDER.routines);
    expect(SIDEBAR_ORDER.routines).toBeLessThan(SIDEBAR_ORDER.team);
  });
});

describe("manifest", () => {
  it("gives every UI slot its own id (the host refuses duplicates)", async () => {
    const { default: manifest } = await import("../src/manifest.js");
    const ids = manifest.ui!.slots!.map((slot) => slot.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
