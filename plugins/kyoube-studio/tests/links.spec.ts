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
    const organization = SECTIONS.find((section: { id: string }) => section.id === "organization");
    const hiddenElsewhere = ["/artifacts", "/skills", "/terminal"];
    expect([...organization.expected, ...hiddenElsewhere].filter((route: string) => !routes.includes(route))).toEqual([]);
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
