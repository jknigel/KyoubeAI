// @vitest-environment happy-dom
// tests/unit/connections-ui.spec.tsx
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppsPage } from "../../src/ui/apps/AppsPage.js";
import { PublishDialog, type PublishPreviewData } from "../../src/ui/apps/PublishDisclosure.js";
import { DataAccessSettingsPage } from "../../src/ui/DataAccessSettingsPage.js";

type BridgeGlobal = typeof globalThis & { __paperclipPluginBridge__?: { sdkUi?: Record<string, unknown> }; IS_REACT_ACT_ENVIRONMENT?: boolean };
const context = { companyId: "c1", companyPrefix: "acme", projectId: null, entityId: null, entityType: null, userId: "u1" };

const STATUS = {
  connections: [
    { name: "stripe", baseUrl: "https://api.stripe.com/v1/", auth: "bearer", methods: "read", available: true, problem: null, apps: [{ slug: "pay", name: "Payments", access: "read" }] },
    { name: "crm", baseUrl: "https://crm.example.com/api/", auth: "header", methods: "read-write", available: false, problem: "secret doesn't resolve", apps: [] },
  ],
  problems: [{ index: 2, name: null, problem: "baseUrl must be https" }],
  missing: [{ name: "slack", apps: [{ slug: "ping", name: "Pinger", access: "read-write" }] }],
};
const GRANTS = {
  grants: [
    { agentId: "a1", connection: "crm", access: "read-write" },
    { agentId: "a1", connection: "gone", access: "read" },
  ],
  agents: [{ id: "a1", name: "Ada" }],
};

let calls: Array<[string, unknown]>;
function installBridge(extra: Record<string, unknown> = {}) {
  calls = [];
  (globalThis as BridgeGlobal).__paperclipPluginBridge__ = {
    sdkUi: {
      usePluginToast: () => () => null,
      usePluginData: () => ({ data: { level: "schema" }, loading: false, error: null, refresh: () => {} }),
      useHostContext: () => ({ companyId: "c1", userId: "u1" }),
      useHostLocation: () => ({ pathname: "/acme/apps", search: "", hash: "" }),
      useHostNavigation: () => ({ linkProps: () => ({ href: "#" }), navigate: () => {} }),
      usePluginAction: (key: string) => async (params: unknown) => {
        calls.push([key, params]);
        if (key in extra) return extra[key];
        if (key === "connections.status") return STATUS;
        if (key === "connections.grants") return GRANTS;
        if (key === "data.grants") return { settings: { defaultAgentLevel: "none", hardDelete: false }, grants: [], agents: [] };
        if (key === "groups.people_levels") return [];
        if (key === "apps.list") return [{ slug: "pay", name: "Payments", description: null, icon: null, status: "published", currentVersion: 1, latestVersion: 1 }];
        if (key === "apps.uses") return { pay: [{ name: "stripe", access: "read" }, { name: "crm", access: "read-write" }] };
        return null;
      },
    },
  };
}

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  (globalThis as BridgeGlobal).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (globalThis as BridgeGlobal).__paperclipPluginBridge__;
});

describe("Connections on the Data access page", () => {
  it("shows each connection with its status, the apps that use it, what is missing, and the grid", async () => {
    installBridge();
    await act(async () => root.render(createElement(DataAccessSettingsPage, { context })));
    const text = container.textContent ?? "";
    expect(text).toContain("api.stripe.com/v1/");
    expect(text).toContain("ready");
    expect(text).toContain("secret doesn't resolve");
    expect(text).toContain("Payments (read)");
    expect(text).toContain("slack");
    expect(text).toContain("Pinger (read-write)");
    expect(text).toContain("baseUrl must be https");
    expect(text).toContain("Settings → Plugins → Kyoube Data & Apps");
    // No secret reference or id is ever asked for or shown.
    expect(text).not.toMatch(/secretId|secret_ref/);
    const grid = container.querySelector("[data-kyoube-grid='connection-grants']")!;
    expect(grid.hasAttribute("data-kyoube-scroll")).toBe(true);
  });

  it("offers read-write only on a connection that allows it, and saves a change", async () => {
    installBridge();
    await act(async () => root.render(createElement(DataAccessSettingsPage, { context })));
    const options = (label: string) => [...container.querySelector<HTMLSelectElement>(`select[aria-label='${label}']`)!.options].map((o) => o.value);
    expect(options("Ada on stripe")).toEqual(["none", "read"]);
    expect(options("Ada on crm")).toEqual(["none", "read", "read-write"]);
    expect(container.querySelector<HTMLSelectElement>("select[aria-label='Ada on crm']")!.value).toBe("read-write");
    const select = container.querySelector<HTMLSelectElement>("select[aria-label='Ada on stripe']")!;
    await act(async () => {
      select.value = "read";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(calls).toContainEqual(["connections.set_grant", { agentId: "a1", connection: "stripe", access: "read" }]);
  });

  it("lists grants for a connection that no longer exists, and Remove sets none", async () => {
    installBridge();
    await act(async () => root.render(createElement(DataAccessSettingsPage, { context })));
    expect(container.textContent).toContain("Ada · gone · read");
    const remove = [...container.querySelectorAll("button")].find((b) => b.textContent === "Remove")!;
    await act(async () => remove.click());
    expect(calls).toContainEqual(["connections.set_grant", { agentId: "a1", connection: "gone", access: "none" }]);
  });
});

const preview = (changed: boolean, setsChanged = false): PublishPreviewData => ({
  version: 2, changed: setsChanged, provider: null, available: true,
  connections: { changed, list: [{ name: "stripe", access: "read", baseUrl: "https://api.stripe.com/v1/", auth: "bearer", methods: "read", available: true, missing: false }] },
  sets: [],
});
const submit = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Publish")!;

describe("Publish dialog connections", () => {
  it("lists the connections and blocks Publish until the box is ticked when they changed", async () => {
    installBridge();
    await act(async () => root.render(createElement(PublishDialog, { slug: "pay", appName: "Payments", mode: "publish", preview: preview(true), onDone: () => {}, onCancel: () => {} })));
    expect(container.textContent).toContain("stripe");
    expect(container.textContent).toContain("This app may call these services with the company's credentials");
    expect(submit().disabled).toBe(true);
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(submit().disabled).toBe(false);
    await act(async () => submit().click());
    expect(calls).toContainEqual(["apps.publish", { slug: "pay", version: 2, decisionsConfirmed: false, connectionsConfirmed: true }]);
  });

  it("shows unchanged connections without a box and sends no flag", async () => {
    installBridge();
    await act(async () => root.render(createElement(PublishDialog, { slug: "pay", appName: "Payments", mode: "publish", preview: preview(false), onDone: () => {}, onCancel: () => {} })));
    expect(container.textContent).toContain("stripe");
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(submit().disabled).toBe(false);
    await act(async () => submit().click());
    const params = calls.find(([key]) => key === "apps.publish")![1] as Record<string, unknown>;
    expect(params.connectionsConfirmed).toBeUndefined();
  });
});

describe("Apps page", () => {
  it("shows a Uses line for an app that declares connections", async () => {
    installBridge();
    await act(async () => root.render(createElement(AppsPage, { context: { ...context } as never })));
    expect(container.textContent).toContain("Uses: stripe (read), crm (read-write)");
  });
});
