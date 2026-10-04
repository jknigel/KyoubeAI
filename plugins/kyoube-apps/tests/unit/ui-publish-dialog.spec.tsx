// @vitest-environment happy-dom
// tests/unit/ui-publish-dialog.spec.tsx
//
// The publish dialog with state and clicks, in a DOM: what the person ticks is what is sent, and a
// tick never outlives the preview it was given for.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PublishDialog, type PublishPreviewData } from "../../src/ui/apps/PublishDisclosure.js";

type BridgeGlobal = typeof globalThis & { __paperclipPluginBridge__?: { sdkUi?: Record<string, unknown> }; IS_REACT_ACT_ENVIRONMENT?: boolean };

const preview = (version: number, changed = true): PublishPreviewData => ({
  version, changed, provider: "openrouter", available: true,
  sets: [{ key: "triage", table: "tickets", fields: ["subject"], advisory: false, questions: [{ key: "queue", type: "choice", text: "Which team?" }] }],
});

let calls: Array<{ action: string; params: Record<string, unknown> }> = [];
let container: HTMLElement;
let root: Root;

beforeEach(() => {
  calls = [];
  (globalThis as BridgeGlobal).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as BridgeGlobal).__paperclipPluginBridge__ = {
    sdkUi: {
      usePluginAction: (action: string) => async (params: Record<string, unknown>) => { calls.push({ action, params }); return {}; },
      usePluginToast: () => () => null,
    },
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (globalThis as BridgeGlobal).__paperclipPluginBridge__;
});

function render(props: Partial<Parameters<typeof PublishDialog>[0]> & { preview: PublishPreviewData }) {
  act(() => {
    root.render(createElement(PublishDialog, { slug: "triage", appName: "Triage", mode: "publish", onDone: () => {}, onCancel: () => {}, ...props }));
  });
}
const checkbox = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
const submit = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Publish" || button.textContent === "Roll back")!;
async function click(element: HTMLElement) {
  await act(async () => { element.click(); });
}

describe("PublishDialog", () => {
  it("keeps Publish disabled until the person ticks the confirmation, then sends it with the reviewed version", async () => {
    render({ preview: preview(3) });
    expect(submit().disabled).toBe(true);
    await click(checkbox());
    expect(checkbox().checked).toBe(true);
    expect(submit().disabled).toBe(false);
    await click(submit());
    expect(calls).toEqual([{ action: "apps.publish", params: { slug: "triage", version: 3, decisionsConfirmed: true } }]);
  });

  it("drops the tick when it is shown a different preview", async () => {
    render({ preview: preview(3) });
    await click(checkbox());
    expect(submit().disabled).toBe(false);
    render({ preview: preview(4) });
    expect(checkbox().checked).toBe(false);
    expect(submit().disabled).toBe(true);
    render({ preview: preview(4), mode: "rollback" });
    expect(checkbox().checked).toBe(false);
  });

  it("never claims a confirmation the person did not give", async () => {
    render({ preview: preview(5, false) });
    expect(checkbox()).toBeNull();
    await click(submit());
    expect(calls).toEqual([{ action: "apps.publish", params: { slug: "triage", version: 5, decisionsConfirmed: false } }]);
  });

  it("rolls back to the version it showed", async () => {
    render({ preview: preview(2), mode: "rollback" });
    await click(checkbox());
    await click(submit());
    expect(calls).toEqual([{ action: "apps.rollback", params: { slug: "triage", version: 2, decisionsConfirmed: true } }]);
  });
});
