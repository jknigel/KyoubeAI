import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PLUGIN_EVENT_TYPES } from "@paperclipai/plugin-sdk";
import manifest, { NOTIFICATIONS_ROUTE, PLUGIN_VERSION, SUBSCRIBED_EVENTS } from "../src/manifest.js";

describe("manifest", () => {
  it("subscribes only to events the pinned SDK declares, so a rename at a core bump fails here", () => {
    for (const event of SUBSCRIBED_EVENTS) expect(PLUGIN_EVENT_TYPES).toContain(event);
  });

  it("keeps the manifest and package versions in step", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(pkg.version).toBe(PLUGIN_VERSION);
    expect(manifest.version).toBe(PLUGIN_VERSION);
  });

  it("puts the card above Studio Home and the page on its own route", () => {
    const slots = manifest.ui?.slots ?? [];
    expect(slots).toContainEqual(expect.objectContaining({ type: "dashboardWidget", exportName: "NotifyCard", order: -1 }));
    expect(slots).toContainEqual(expect.objectContaining({ type: "page", exportName: "NotificationsPage", routePath: NOTIFICATIONS_ROUTE }));
  });
});
