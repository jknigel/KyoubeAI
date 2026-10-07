import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { CARD_COPY, NotifyCard } from "../src/ui/NotifyCard.js";
import { NotificationsPage, deliveryText } from "../src/ui/NotificationsPage.js";

type BridgeGlobal = typeof globalThis & { __paperclipPluginBridge__?: { sdkUi?: Record<string, unknown> } };
const context = { companyId: "c1", companyPrefix: null, projectId: null, entityId: null, entityType: null, userId: "u1" };

function installBridge() {
  (globalThis as BridgeGlobal).__paperclipPluginBridge__ = {
    sdkUi: {
      useHostContext: () => context,
      useHostLocation: () => ({ pathname: "/ACM/dashboard", search: "", hash: "" }),
      useHostNavigation: () => ({ resolveHref: (to: string) => to, navigate: () => {}, linkProps: (to: string) => ({ href: to, onClick: () => {} }) }),
      usePluginAction: () => async () => ({ publicKey: "", prefs: { failures: false, comments: false }, devices: [] }),
      usePluginToast: () => () => null,
    },
  };
}
afterEach(() => { delete (globalThis as BridgeGlobal).__paperclipPluginBridge__; });

describe("NotifyCard", () => {
  it("renders a hidden marker until it knows the device's state, so the host's card frame is hidden too", () => {
    installBridge();
    expect(renderToStaticMarkup(createElement(NotifyCard, { context }))).toBe('<span data-kyoube-notify="hidden"></span>');
  });

  it("explains every state in which push cannot simply be turned on", () => {
    expect(CARD_COPY["ios-install"].body).toContain("Add to Home Screen");
    expect(CARD_COPY.insecure.body).toContain("https://");
    expect(CARD_COPY.denied.body).toContain("settings");
    expect(CARD_COPY.off.title).toBe("Get notified on this device");
  });
});

describe("NotificationsPage", () => {
  it("renders its loading state before the config call answers", () => {
    installBridge();
    expect(renderToStaticMarkup(createElement(NotificationsPage, { context }))).toContain("Loading");
  });

  it("describes a device's last delivery", () => {
    const now = Date.parse("2026-10-07T10:10:00Z");
    const base = { id: "d", label: "iPhone", endpoint: "https://web.push.apple.com/x", createdAt: "2026-10-07T09:00:00Z", lastSuccessAt: null, lastError: null, lastErrorAt: null };
    expect(deliveryText(base, now)).toBe("Added 1 h ago");
    expect(deliveryText({ ...base, lastSuccessAt: "2026-10-07T10:08:00Z" }, now)).toBe("Last delivered 2 min ago");
    expect(deliveryText({ ...base, lastSuccessAt: "2026-10-07T10:00:00Z", lastError: "push service refused the request (403)", lastErrorAt: "2026-10-07T10:09:50Z" }, now)).toBe("Last attempt failed: push service refused the request (403)");
  });
});
