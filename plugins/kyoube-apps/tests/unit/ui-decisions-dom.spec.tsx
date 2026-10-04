// @vitest-environment happy-dom
// tests/unit/ui-decisions-dom.spec.tsx
//
// The Typed decisions settings with state and events, in a DOM.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DecisionsSettings, DecisionsSettingsView, type DecisionSettingsViewData } from "../../src/ui/DecisionsSettings.js";

type BridgeGlobal = typeof globalThis & { __paperclipPluginBridge__?: { sdkUi?: Record<string, unknown> }; IS_REACT_ACT_ENVIRONMENT?: boolean };

const view: DecisionSettingsViewData = {
  settings: { agents: true, columns: false, apps: false, guardrail: false, dailyCap: 10000 },
  provider: { configured: true, provider: "openrouter", model: "typesafe/jev-1.13", keyResolves: true, problem: null },
  usage: { used: 37, cap: 10000 },
};

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

const capBox = () => container.querySelector<HTMLInputElement>('input[type="number"]')!;
async function typeAndLeave(value: string) {
  await act(async () => {
    const box = capBox();
    box.focus();
    box.value = value;
    box.blur();
  });
}

describe("DecisionsSettingsView's daily cap", () => {
  it("ignores an emptied box instead of setting the cap to 0", async () => {
    const changes: unknown[] = [];
    act(() => root.render(createElement(DecisionsSettingsView, { view, onChange: (patch) => void changes.push(patch) })));
    await typeAndLeave("");
    expect(capBox().value).toBe("10000");
    await typeAndLeave("   ");
    await typeAndLeave("10000");
    await typeAndLeave("-3");
    await typeAndLeave("2.5");
    expect(changes).toEqual([]);
    await typeAndLeave("0");
    await typeAndLeave("250");
    expect(changes).toEqual([{ dailyCap: 0 }, { dailyCap: 250 }]);
  });
});

describe("DecisionsSettings", () => {
  it("clears an earlier load error once a reload succeeds", async () => {
    let fail = true;
    (globalThis as BridgeGlobal).__paperclipPluginBridge__ = {
      sdkUi: {
        usePluginAction: () => async () => { if (fail) throw new Error("forbidden: only company admins manage data access"); return view; },
        usePluginToast: () => () => null,
      },
    };
    await act(async () => root.render(createElement(DecisionsSettings, { companyId: "c1" })));
    expect(container.textContent).toContain("only company admins manage data access");
    fail = false;
    await act(async () => root.render(createElement(DecisionsSettings, { companyId: "c2" })));
    expect(container.textContent).not.toContain("only company admins");
    expect(container.textContent).toContain("Typed decisions");
  });
});
