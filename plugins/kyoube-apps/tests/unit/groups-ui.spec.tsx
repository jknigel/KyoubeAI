// @vitest-environment happy-dom
// tests/unit/groups-ui.spec.tsx
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupsSettingsPage } from "../../src/ui/groups/GroupsSettingsPage.js";

type BridgeGlobal = typeof globalThis & { __paperclipPluginBridge__?: { sdkUi?: Record<string, unknown> }; IS_REACT_ACT_ENVIRONMENT?: boolean };
const context = { companyId: "c1", companyPrefix: "acme", projectId: null, entityId: null, entityType: null, userId: "u1" };

const list = (unlocked: boolean) => ({
  unlocked,
  groups: [{ id: "g1", name: "Sales", dataLevel: null, members: ["u2"], agents: [], apps: ["app1"] }],
  sync: null,
});
const options = { members: [{ id: "u2", role: "operator" }], agents: [], apps: [{ id: "app1", name: "Contacts", icon: "C" }] };

let calls: Array<[string, unknown]>;
let toasts: Array<{ title: string; tone: string }>;
/** When set, `groups.save` is refused with this error. */
let saveError: Error | null;
function installBridge(unlocked: boolean) {
  calls = [];
  toasts = [];
  saveError = null;
  (globalThis as BridgeGlobal).__paperclipPluginBridge__ = {
    sdkUi: {
      usePluginToast: () => (toast: { title: string; tone: string }) => { toasts.push(toast); return null; },
      usePluginAction: (key: string) => async (params: unknown) => {
        calls.push([key, params]);
        if (key === "groups.list") return list(unlocked);
        if (key === "groups.options") return options;
        if (key === "groups.save" && saveError) throw saveError;
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

  it("keeps the editor open with the person's edits when a save is refused, and closes it once a save succeeds", async () => {
    installBridge(true);
    await act(async () => root.render(createElement(GroupsSettingsPage, { context })));
    await act(async () => buttonNamed("Sales").click());
    const name = () => container.querySelector<HTMLInputElement>("input[maxlength='80']");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name()!, "Sales EMEA");
      name()!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const level = container.querySelector<HTMLSelectElement>("select")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(level, "write");
      level.dispatchEvent(new Event("change", { bubbles: true }));
    });

    saveError = new Error("a group named Sales EMEA already exists");
    await act(async () => buttonNamed("Save").click());
    expect(calls).toContainEqual(["groups.save", { group: { id: "g1", name: "Sales EMEA", dataLevel: "write", members: ["u2"], agents: [], apps: ["app1"] } }]);
    expect(toasts.at(-1)).toMatchObject({ tone: "error" });
    expect(name()?.value).toBe("Sales EMEA");
    expect(container.querySelector<HTMLSelectElement>("select")?.value).toBe("write");

    saveError = null;
    await act(async () => buttonNamed("Save").click());
    expect(toasts.at(-1)).toEqual({ title: "Group saved", tone: "success" });
    expect(name()).toBeNull();
  });
});
