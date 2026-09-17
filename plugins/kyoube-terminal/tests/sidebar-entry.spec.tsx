import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { SidebarEntry } from "../src/ui/SidebarEntry.js";

type BridgeGlobal = typeof globalThis & { __paperclipPluginBridge__?: { sdkUi?: Record<string, unknown> } };

function installBridge(canOpen: { allowed: boolean; role: string | null } | null) {
  (globalThis as BridgeGlobal).__paperclipPluginBridge__ = {
    sdkUi: {
      useHostContext: () => ({ companyId: "c1", companyPrefix: "acme", projectId: null, entityId: null, entityType: null, userId: "u1" }),
      useHostNavigation: () => ({
        resolveHref: (to: string) => `/acme${to}`,
        navigate: () => {},
        linkProps: (to: string) => ({ href: `/acme${to}`, onClick: () => {} }),
      }),
      usePluginData: () => ({ data: canOpen, loading: canOpen === null, error: null, refresh: () => {} }),
    },
  };
}

afterEach(() => { delete (globalThis as BridgeGlobal).__paperclipPluginBridge__; });

describe("SidebarEntry", () => {
  const context = { companyId: "c1", companyPrefix: "acme", projectId: null, entityId: null, entityType: null, userId: "u1" };
  it("renders a link to the terminal page for allowed users", () => {
    installBridge({ allowed: true, role: "admin" });
    const html = renderToStaticMarkup(createElement(SidebarEntry, { context }));
    expect(html).toContain('href="/acme/terminal"');
    expect(html).toContain("Terminal");
  });
  it("renders nothing for users who cannot open a terminal or while loading", () => {
    installBridge({ allowed: false, role: "member" });
    expect(renderToStaticMarkup(createElement(SidebarEntry, { context }))).toBe("");
    installBridge(null);
    expect(renderToStaticMarkup(createElement(SidebarEntry, { context }))).toBe("");
  });
});
