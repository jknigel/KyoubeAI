// @vitest-environment happy-dom
// tests/unit/groups-ui.spec.tsx
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataAccessSettingsPage } from "../../src/ui/DataAccessSettingsPage.js";
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

  it("is laid out for a 375px phone: the list scrolls in its own box, long ids break, controls are 44px tall (R21)", async () => {
    installBridge(true);
    (window as unknown as { happyDOM: { setViewport: (v: { width: number; height: number }) => void } }).happyDOM.setViewport({ width: 375, height: 812 });
    await act(async () => root.render(createElement(GroupsSettingsPage, { context })));
    const page = container.querySelector<HTMLElement>("[data-kyoube-page='groups']")!;
    expect(page).not.toBeNull();
    const scroller = container.querySelector("table")!.parentElement!;
    expect(scroller.hasAttribute("data-kyoube-scroll")).toBe(true);
    expect(scroller.className).toContain("overflow-x-auto");
    const css = document.getElementById("kyoube-apps-phone-styles")?.textContent ?? "";
    expect(css).toContain("[data-kyoube-scroll] { max-width: 100%; overflow-x: auto; }");
    expect(css).toMatch(/@media \(max-width: 639px\)[\s\S]*\[data-kyoube-page="groups"\] button[\s\S]*min-height: 44px/);
    // The editor's pickers break long member ids instead of running past their box.
    await act(async () => buttonNamed("Sales").click());
    const label = [...container.querySelectorAll("fieldset label span")].find((span) => span.textContent?.startsWith("u2"))!;
    expect(label.hasAttribute("data-kyoube-break")).toBe(true);
    expect(label.className).toContain("break-all");
    // happy-dom applies the media query: at 375px the controls are 44px tall, at desktop width they are not.
    expect([window.innerWidth, getComputedStyle(buttonNamed("Save")).minHeight]).toEqual([375, "44px"]);
    expect(getComputedStyle(container.querySelector<HTMLInputElement>("input[maxlength='80']")!).minHeight).toBe("44px");
  });

  it("lets the Data access people table scroll in its own box and break long ids (R21)", async () => {
    const longId = "user_".concat("x".repeat(60));
    (globalThis as BridgeGlobal).__paperclipPluginBridge__ = {
      sdkUi: {
        usePluginToast: () => () => null,
        usePluginData: () => ({ data: null, loading: false, error: null, refresh: () => {} }),
        usePluginAction: (key: string) => async () => {
          if (key === "groups.people_levels") return [{ userId: longId, role: "viewer", level: "read", source: "role: viewer (groups cannot raise a viewer)" }];
          if (key === "data.grants") return { settings: { defaultAgentLevel: "none", hardDelete: false }, grants: [], agents: [] };
          return null;
        },
      },
    };
    await act(async () => root.render(createElement(DataAccessSettingsPage, { context })));
    expect(container.querySelector("[data-kyoube-page='data-access']")).not.toBeNull();
    const cell = [...container.querySelectorAll("td")].find((td) => td.textContent === longId)!;
    expect(cell.hasAttribute("data-kyoube-break")).toBe(true);
    expect(cell.closest("table")!.parentElement!.hasAttribute("data-kyoube-scroll")).toBe(true);
    expect(container.textContent).toContain("role: viewer (groups cannot raise a viewer)");
  });

  it("keeps desktop controls their own height (the 44px rule is phone-only)", async () => {
    installBridge(true);
    (window as unknown as { happyDOM: { setViewport: (v: { width: number; height: number }) => void } }).happyDOM.setViewport({ width: 1280, height: 800 });
    await act(async () => root.render(createElement(GroupsSettingsPage, { context })));
    await act(async () => buttonNamed("Sales").click());
    expect(window.innerWidth).toBe(1280);
    expect(getComputedStyle(buttonNamed("Save")).minHeight).not.toBe("44px");
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
