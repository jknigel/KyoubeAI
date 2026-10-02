import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { licenseStatus } from "@kyoube/license";
import { chipLabel, LicenceChip } from "../src/ui/LicenceChip.js";
import { LicencePanel } from "../src/ui/LicencePanel.js";
import { errorText } from "../src/ui/error-text.js";
import type { LicenceView } from "../src/shared.js";

type BridgeGlobal = typeof globalThis & { __paperclipPluginBridge__?: { sdkUi?: Record<string, unknown> } };
function installBridge() {
  (globalThis as BridgeGlobal).__paperclipPluginBridge__ = {
    sdkUi: {
      useHostContext: () => ({ companyId: "c1", companyPrefix: "acme", userId: "u1" }),
      useHostNavigation: () => ({ resolveHref: (to: string) => `/acme${to}`, navigate: () => {}, linkProps: (to: string) => ({ href: `/acme${to}`, onClick: () => {} }) }),
      usePluginAction: () => async () => ({ visible: false, reason: "not_admin" }),
    },
  };
}
afterEach(() => { delete (globalThis as BridgeGlobal).__paperclipPluginBridge__; });

const view = (count: number): LicenceView => ({
  visible: true,
  status: licenseStatus({ key: null, instanceId: "inst-1", userCount: count, now: new Date("2026-10-03T00:00:00Z"), trustedKeys: {} }),
  instanceId: "inst-1",
  snapshotAt: "2026-10-03T11:59:00.000Z",
  users: [{ id: "u1", email: "u1@x.test", name: "User 1", createdAt: "2026-10-01T00:00:00.000Z", isInstanceAdmin: true, removeCommand: "kyoube users remove u1@x.test" }],
});

const panel = (props: Partial<Parameters<typeof LicencePanel>[0]>) =>
  renderToStaticMarkup(createElement(LicencePanel, { answer: null, error: null, keyText: "", busy: false, notice: null, onKeyText: () => {}, onApply: () => {}, onClear: () => {}, terminalLinkProps: { href: "/acme/terminal" }, ...props }));

describe("LicencePanel", () => {
  it("shows the summary, the instance ID, the users and their remove command", () => {
    const html = panel({ answer: view(1) });
    expect(html).toContain("Free: 1 of 5 users");
    expect(html).toContain("inst-1");
    expect(html).toContain("u1@x.test");
    expect(html).toContain("kyoube users remove u1@x.test");
    expect(html).toContain('href="/acme/terminal"');
    expect(html).toContain("Apply");
  });
  it("tells a non-admin the page is for instance admins", () => {
    expect(panel({ answer: { visible: false, reason: "not_admin" } })).toContain("Only instance admins can see the licence.");
  });
  it("says the user list is still being read", () => {
    expect(panel({ answer: { visible: false, reason: "no_snapshot" } })).toContain("still reading the user list");
  });
  it("shows an error and a notice when given them", () => {
    const html = panel({ answer: view(1), error: "This key isn't valid.", notice: "Licence applied." });
    expect(html).toContain("This key isn&#x27;t valid.");
    expect(html).toContain("Licence applied.");
  });
});

describe("chipLabel", () => {
  it("is null when nothing needs attention, and names the problem otherwise", () => {
    expect(chipLabel(view(1))).toBeNull();
    expect(chipLabel(view(5))).toBe("Users 5/5");
  });
});

describe("LicenceChip", () => {
  it("renders nothing before the worker answers", () => {
    installBridge();
    expect(renderToStaticMarkup(createElement(LicenceChip, {}))).toBe("");
  });
});

describe("errorText", () => {
  it("reads a bridge rejection, which is a plain object", () => {
    expect(errorText({ code: "x", message: "forbidden: only instance admins can change the licence" })).toBe("forbidden: only instance admins can change the licence");
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText(42)).toBe("Something went wrong.");
  });
});
