// @vitest-environment happy-dom
// tests/unit/groups-ui.spec.tsx
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupsSettingsPage } from "../../src/ui/groups/GroupsSettingsPage.js";
import { AgentAccessTab } from "../../src/ui/groups/AgentAccessTab.js";

type BridgeGlobal = typeof globalThis & { __paperclipPluginBridge__?: { sdkUi?: Record<string, unknown> }; IS_REACT_ACT_ENVIRONMENT?: boolean };
const context = { companyId: "c1", companyPrefix: "acme", projectId: null, entityId: null, entityType: null, userId: "u1" };

const list = (unlocked: boolean) => ({
  unlocked,
  groups: [{ id: "g1", name: "Sales", dataLevel: null, members: ["u2"], agents: [], apps: ["app1"] }],
  sync: null,
});
const options = { members: [{ id: "u2", role: "operator" }], agents: [], apps: [{ id: "app1", name: "Contacts", icon: "C" }] };

let calls: Array<[string, unknown]>;
function installBridge(unlocked: boolean) {
  calls = [];
  (globalThis as BridgeGlobal).__paperclipPluginBridge__ = {
    sdkUi: {
      usePluginToast: () => () => null,
      usePluginAction: (key: string) => async (params: unknown) => {
        calls.push([key, params]);
        if (key === "groups.list") return list(unlocked);
        if (key === "groups.options") return options;
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
  vi.restoreAllMocks();
});

const buttonNamed = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === text)!;

describe("GroupsSettingsPage", () => {
  it("shows the licence banner and disables Save while Delete stays enabled when locked", async () => {
    installBridge(false);
    await act(async () => root.render(createElement(GroupsSettingsPage, { context })));
    expect(container.textContent).toContain("Managing groups needs a KyoubeAI licence");
    expect(container.textContent).toContain("Agent rules have not synced yet");
    expect(buttonNamed("Delete").disabled).toBe(false);
    await act(async () => buttonNamed("Sales").click());
    expect(buttonNamed("Save").disabled).toBe(true);
    expect(buttonNamed("Delete").disabled).toBe(false);
  });

  it("asks before a delete opens an app to everyone, and does not delete on cancel", async () => {
    installBridge(true);
    const confirm = vi.fn(() => false);
    window.confirm = confirm;
    await act(async () => root.render(createElement(GroupsSettingsPage, { context })));
    await act(async () => buttonNamed("Delete").click());
    expect(confirm).toHaveBeenCalledWith("This makes Contacts usable by everyone. Continue?");
    expect(calls.some(([key]) => key === "groups.delete")).toBe(false);
    confirm.mockReturnValue(true);
    await act(async () => buttonNamed("Delete").click());
    expect(calls).toContainEqual(["groups.delete", { id: "g1" }]);
  });
});

describe("AgentAccessTab", () => {
  async function render(names: string[]) {
    (globalThis as BridgeGlobal).__paperclipPluginBridge__ = { sdkUi: { usePluginAction: () => async () => names } };
    await act(async () => root.render(createElement(AgentAccessTab, { context: { ...context, entityId: "a1", entityType: "agent" } })));
  }
  it("names the groups that restrict the agent", async () => {
    await render(["Sales"]);
    expect(container.textContent).toContain("Restricted to: Sales");
  });
  it("says everyone can give an unrestricted agent work", async () => {
    await render([]);
    expect(container.textContent).toContain("Everyone in the company can give this agent work.");
  });
});
