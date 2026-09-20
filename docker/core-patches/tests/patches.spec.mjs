import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPatches, applyToText, expandGlob } from "../lib.mjs";
import { PATCHES, SKIP_HARNESS_LABEL, SKIP_HARNESS_MESSAGE } from "../patches.mjs";

// The message_end handler exactly as core 2026.831.1's minified UI bundle
// carries it (ui/dist/assets/index-BHbrFFmp.js), with the branches on
// either side so the pattern is proven to anchor on this handler alone.
const PI_HANDLER_2026_831_1 =
  'if(r==="message_start")return[];if(r==="message_update"){const i=uS(n.assistantMessageEvent);if(i){const a=sf(i.type);if(a==="text_end"){const o=sf(i.content);if(o)return[{kind:"assistant",ts:t,text:o}]}}return[]}' +
  'if(r==="message_end"){const i=uS(n.message);if(i){const a=i.content,{text:o,thinking:l}=hS(a),c=[];return l&&c.push({kind:"thinking",ts:t,text:l}),o&&c.push({kind:"assistant",ts:t,text:o}),c}return[]}' +
  'if(r==="tool_execution_start"){const i=sf(n.toolCallId,`tool-${Date.now()}`);return[{kind:"tool_call",ts:t,name:"x",toolUseId:i}]}';

const piPatch = PATCHES.find((patch) => patch.id === "pi-transcript-non-assistant-messages");

// The onboarding wizard's hire handler (`handleGiveHeartbeat`) from the same
// bundle: the environment-test gate and the hire call that follows it. The
// snippet sits directly in the handler's `try` block, which is what lets the
// patch read `arguments[0]`; the wrapper below reproduces that placement.
const HIRE_GATE_2026_831_1 =
  'if(Vn){const Tn=(Te&&Te.status!=="fail"?Te:null)??await lt();if(!Tn)return;if(Tn.status==="fail"){H("The environment test failed. Fix the reported checks before you hire this agent.");return}}' +
  'if(!Xe)return;const nt=await Xt.hire(xt,{name:Ue.trim()||L3[Xe],role:Xe,adapterType:Ve,adapterConfig:ht(),runtimeConfig:zYe()});';

// The wizard's error line followed by its footer navigation, as rendered for
// the agent-arc steps (same bundle). Two array children of the step body.
const ERROR_AND_FOOTER_2026_831_1 =
  'Gr&&(0,s.jsx)("div",{className:"mt-3",children:(0,s.jsx)("p",{className:"text-xs text-destructive",children:Gr})}),' +
  'qt&&(0,s.jsx)(Spn,{onBack:jSe({currentStep:_,entryStep:C})?()=>I(zn(_)):void 0,primaryLabel:_===3?"Next":_===4?"Connect":"Get started",loadingLabel:_===4?"Connecting...":"Launching...",loading:_===3?!1:L,primaryDisabled:_===3?!Ue.trim():_===4?L||dt||_t:L||Er,onPrimary:()=>{_===3?I(4):_===4?fs():Pr()}})';

const handlerPatch = PATCHES.find((patch) => patch.id === "onboarding-skip-harness-handler");
const buttonPatch = PATCHES.find((patch) => patch.id === "onboarding-skip-harness-button");

/** A bundle fragment carrying every region the declared patches target, once each. */
const FULL_BUNDLE_2026_831_1 = `const x=1;${PI_HANDLER_2026_831_1};async function fs(){try{${HIRE_GATE_2026_831_1}}catch{}}const y=[${ERROR_AND_FOOTER_2026_831_1}];`;

/** Runs the (patched or unpatched) handler text as the parser would, with the minified helpers stubbed. */
function runHandler(code, message) {
  const uS = (value) => (typeof value === "object" && value !== null ? value : null);
  const sf = (value, fallback = "") => (typeof value === "string" ? value : fallback);
  const hS = (content) => ({ text: content.filter((c) => c.type === "text").map((c) => c.text).join(""), thinking: "" });
  const fn = new Function("r", "n", "t", "uS", "sf", "hS", `${code};return "fell-through"`);
  return fn("message_end", { message }, "2026-09-19T00:00:00Z", uS, sf, hS);
}

describe("pi-transcript-non-assistant-messages", () => {
  it("is declared with the safety fields every patch needs", () => {
    expect(piPatch).toBeDefined();
    expect(piPatch.upstream).toContain("github.com/paperclipai/paperclip");
    expect(piPatch.expect).toBe(1);
    expect(piPatch.pattern.flags).toContain("g");
  });

  it("matches the 2026.831.1 handler exactly once, whatever the minifier called the identifiers", () => {
    const { count, text } = applyToText(PI_HANDLER_2026_831_1, piPatch);
    expect(count).toBe(1);
    expect(text).toContain('if(r==="message_end"){const i=uS(n.message);if(i&&i.role!=="assistant")return[];if(i){');
    const renamed = PI_HANDLER_2026_831_1.replaceAll("uS(", "Qx(").replaceAll("const i=", "const Z=").replaceAll("if(i){", "if(Z){").replaceAll("i.content", "Z.content");
    expect(applyToText(renamed, piPatch).count).toBe(1);
  });

  it("does not match again once applied, so a core that already carries the fix fails the build", () => {
    const once = applyToText(PI_HANDLER_2026_831_1, piPatch).text;
    expect(applyToText(once, piPatch).count).toBe(0);
  });

  it("keeps the assistant's text and drops the wake prompt and tool results — proven by running the patched code", () => {
    const text = (s) => [{ type: "text", text: s }];
    const before = PI_HANDLER_2026_831_1;
    const after = applyToText(before, piPatch).text;
    // Upstream: every role becomes agent text.
    expect(runHandler(before, { role: "user", content: text("## KyoubeAI Resume Delta") })).toEqual([{ kind: "assistant", ts: "2026-09-19T00:00:00Z", text: "## KyoubeAI Resume Delta" }]);
    expect(runHandler(before, { role: "toolResult", content: text("=== doc revisions ===") })).toHaveLength(1);
    // Patched: only the assistant's own message does.
    expect(runHandler(after, { role: "user", content: text("## KyoubeAI Resume Delta") })).toEqual([]);
    expect(runHandler(after, { role: "toolResult", content: text("=== doc revisions ===") })).toEqual([]);
    expect(runHandler(after, { role: "assistant", content: text("Done — the pack is sent.") })).toEqual([{ kind: "assistant", ts: "2026-09-19T00:00:00Z", text: "Done — the pack is sent." }]);
    expect(runHandler(after, null)).toEqual([]);
  });
});

/**
 * Runs the (patched or unpatched) hire gate as the wizard would: inside a plain
 * `async function` whose first argument is whatever the caller passed, with the
 * minified state and API stubbed. Returns what the handler did.
 */
async function runHireGate(code, { envResult, cached = null, isLocal = true, arg } = {}) {
  const calls = { probes: 0, errors: [], hired: null };
  const fn = new Function(
    "Vn", "Te", "lt", "H", "Xe", "Xt", "xt", "Ue", "L3", "Ve", "ht", "zYe",
    `return async function fs(){${code}return nt}`,
  )(
    isLocal,
    cached,
    async () => { calls.probes += 1; return envResult; },
    (message) => { calls.errors.push(message); },
    "ceo",
    { hire: async (companyId, payload) => { calls.hired = { companyId, payload }; return { agent: { id: "agent-1" } }; } },
    "company-1",
    "Lead",
    { ceo: "CEO" },
    "claude_local",
    () => ({}),
    () => ({}),
  );
  const returned = arg === undefined ? await fn() : await fn(arg);
  return { ...calls, returned };
}

describe("onboarding-skip-harness-handler", () => {
  it("is declared with the safety fields every patch needs", () => {
    expect(handlerPatch).toBeDefined();
    expect(handlerPatch.upstream).toContain("github.com/paperclipai/paperclip");
    expect(handlerPatch.expect).toBe(1);
    expect(handlerPatch.pattern.flags).toContain("g");
  });

  it("matches the 2026.831.1 hire gate exactly once, whatever the minifier called the identifiers", () => {
    const { count, text } = applyToText(HIRE_GATE_2026_831_1, handlerPatch);
    expect(count).toBe(1);
    expect(text).toContain('if(Vn&&arguments[0]!==!0){');
    expect(text).toContain(`H(${JSON.stringify(SKIP_HARNESS_MESSAGE)});return}}`);
    const renamed = HIRE_GATE_2026_831_1.replaceAll("Vn", "Qx").replaceAll("Tn", "Zz").replaceAll("Te", "Yy").replaceAll("lt()", "Ww()").replaceAll("H(", "Hh(");
    expect(applyToText(renamed, handlerPatch).count).toBe(1);
  });

  it("does not match again once applied", () => {
    const once = applyToText(HIRE_GATE_2026_831_1, handlerPatch).text;
    expect(applyToText(once, handlerPatch).count).toBe(0);
  });

  it("still blocks the hire on a failed probe, now with the message that names the skip — proven by running the patched code", async () => {
    const after = applyToText(HIRE_GATE_2026_831_1, handlerPatch).text;
    const fail = { status: "fail", checks: [] };
    const before = await runHireGate(HIRE_GATE_2026_831_1, { envResult: fail });
    expect(before.hired).toBeNull();
    expect(before.errors).toEqual(["The environment test failed. Fix the reported checks before you hire this agent."]);
    const patched = await runHireGate(after, { envResult: fail });
    expect(patched.hired).toBeNull();
    expect(patched.probes).toBe(1);
    expect(patched.errors).toEqual([SKIP_HARNESS_MESSAGE]);
  });

  it("skips the probe and hires only on an explicit `true`; a click event or no argument keeps the gate", async () => {
    const after = applyToText(HIRE_GATE_2026_831_1, handlerPatch).text;
    const fail = { status: "fail", checks: [] };
    const skipped = await runHireGate(after, { envResult: fail, arg: true });
    expect(skipped.probes).toBe(0);
    expect(skipped.errors).toEqual([]);
    expect(skipped.hired).toEqual({ companyId: "company-1", payload: expect.objectContaining({ role: "ceo", adapterType: "claude_local", name: "Lead" }) });
    // The non-arc footer passes the handler straight to onClick, so it
    // receives the click event: that must not read as a skip.
    const clicked = await runHireGate(after, { envResult: fail, arg: { type: "click" } });
    expect(clicked.probes).toBe(1);
    expect(clicked.hired).toBeNull();
    // A passing probe hires as before, with or without the skip.
    const pass = await runHireGate(after, { envResult: { status: "pass", checks: [] } });
    expect(pass.probes).toBe(1);
    expect(pass.hired).not.toBeNull();
  });
});

/** Evaluates the (patched or unpatched) error+footer children with the wizard's render scope stubbed. */
function renderErrorAndFooter(code, { step, error, loading = false }) {
  const s = { jsx: (type, props) => ({ type, props }) };
  const fsCalls = [];
  const fn = new Function(
    "s", "Gr", "qt", "Spn", "jSe", "I", "zn", "_", "C", "L", "Ue", "dt", "_t", "Er", "fs", "Pr",
    `return [${code}]`,
  );
  const children = fn(
    s, error, true, "FooterNav", () => true, () => {}, (n) => n - 1, step, 3, loading, { trim: () => "Lead" }, false, false, false,
    (...args) => { fsCalls.push(args); }, () => {},
  );
  return { children, fsCalls };
}

describe("onboarding-skip-harness-button", () => {
  it("is declared with the safety fields every patch needs", () => {
    expect(buttonPatch).toBeDefined();
    expect(buttonPatch.upstream).toContain("github.com/paperclipai/paperclip");
    expect(buttonPatch.expect).toBe(1);
    expect(buttonPatch.pattern.flags).toContain("g");
  });

  it("matches the 2026.831.1 error line and footer exactly once, whatever the minifier called the identifiers", () => {
    const { count, text } = applyToText(ERROR_AND_FOOTER_2026_831_1, buttonPatch);
    expect(count).toBe(1);
    expect(text).toContain(`_===4&&Gr===${JSON.stringify(SKIP_HARNESS_MESSAGE)}&&(0,s.jsx)("div",{className:"mt-2"`);
    expect(text).toContain('onClick:()=>fs(!0)');
    // The footer call is re-emitted untouched.
    expect(text).toContain(ERROR_AND_FOOTER_2026_831_1.slice(ERROR_AND_FOOTER_2026_831_1.indexOf("qt&&")));
    const renamed = ERROR_AND_FOOTER_2026_831_1.replaceAll("Gr", "Ee").replaceAll("(0,s.jsx)", "Kt.jsx").replaceAll("fs()", "Qq()").replaceAll("_===", "St===").replaceAll("currentStep:_", "currentStep:St").replaceAll("zn(_)", "zn(St)");
    expect(applyToText(renamed, buttonPatch).count).toBe(1);
  });

  it("does not match again once applied", () => {
    const once = applyToText(ERROR_AND_FOOTER_2026_831_1, buttonPatch).text;
    expect(applyToText(once, buttonPatch).count).toBe(0);
  });

  it("renders the skip control only on step 4 under the handler's message, and it calls the hire handler with `true` — proven by running the patched code", () => {
    const after = applyToText(ERROR_AND_FOOTER_2026_831_1, buttonPatch).text;
    // Upstream: error line and footer only.
    const before = renderErrorAndFooter(ERROR_AND_FOOTER_2026_831_1, { step: 4, error: SKIP_HARNESS_MESSAGE });
    expect(before.children).toHaveLength(2);
    expect(before.children[1].type).toBe("FooterNav");

    const shown = renderErrorAndFooter(after, { step: 4, error: SKIP_HARNESS_MESSAGE });
    expect(shown.children).toHaveLength(3);
    expect(shown.children[0].props.children.props.children).toBe(SKIP_HARNESS_MESSAGE);
    const button = shown.children[1].props.children;
    expect(button.type).toBe("button");
    expect(button.props.type).toBe("button");
    expect(button.props.children).toBe(SKIP_HARNESS_LABEL);
    expect(button.props.disabled).toBe(false);
    button.props.onClick();
    expect(shown.fsCalls).toEqual([[true]]);
    expect(shown.children[2].type).toBe("FooterNav");
    expect(shown.children[2].props.primaryLabel).toBe("Connect");

    // Any other error, any other step, or no error: the slot is falsy, so React renders nothing there.
    expect(renderErrorAndFooter(after, { step: 4, error: "Failed to create agent" }).children[1]).toBeFalsy();
    expect(renderErrorAndFooter(after, { step: 5, error: SKIP_HARNESS_MESSAGE }).children[1]).toBeFalsy();
    expect(renderErrorAndFooter(after, { step: 4, error: null }).children[0]).toBeFalsy();
    expect(renderErrorAndFooter(after, { step: 4, error: null }).children[1]).toBeFalsy();
    // While the hire is in flight the control is disabled with the footer.
    expect(renderErrorAndFooter(after, { step: 4, error: SKIP_HARNESS_MESSAGE, loading: true }).children[1].props.children.props.disabled).toBe(true);
  });
});

describe("applyPatches", () => {
  let root;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "core-patches-"));
    await mkdir(path.join(root, "ui", "dist", "assets"), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("expands a single-star glob in the basename", async () => {
    await writeFile(path.join(root, "ui/dist/assets/index-AAAA.js"), "");
    await writeFile(path.join(root, "ui/dist/assets/index-AAAA.js.map"), "");
    await writeFile(path.join(root, "ui/dist/assets/other-BBBB.js"), "");
    expect((await expandGlob(root, "ui/dist/assets/index-*.js")).map((f) => path.basename(f))).toEqual(["index-AAAA.js"]);
    expect(await expandGlob(root, "nope/*.js")).toEqual([]);
  });

  it("rewrites the bundle in place and reports it", async () => {
    const file = path.join(root, "ui/dist/assets/index-BHbrFFmp.js");
    await writeFile(file, FULL_BUNDLE_2026_831_1);
    const report = await applyPatches(root, PATCHES);
    expect(report).toEqual(PATCHES.map((patch) => ({ id: patch.id, matched: 1, expect: 1, files: ["ui/dist/assets/index-BHbrFFmp.js"] })));
    const patched = await readFile(file, "utf8");
    expect(patched).toContain('.role!=="assistant")return[]');
    expect(patched).toContain("arguments[0]!==!0");
    expect(patched).toContain(SKIP_HARNESS_LABEL);
  });

  it("fails — without writing — when a patch matches zero times or more than declared", async () => {
    const file = path.join(root, "ui/dist/assets/index-BHbrFFmp.js");
    await writeFile(file, "nothing here");
    await expect(applyPatches(root, PATCHES)).rejects.toThrow(/matched 0 time\(s\).*expected 1/);
    await writeFile(file, FULL_BUNDLE_2026_831_1 + FULL_BUNDLE_2026_831_1);
    await expect(applyPatches(root, PATCHES)).rejects.toThrow(/matched 2 time\(s\).*expected 1/);
    // A bundle that carries only one region still fails the build on the
    // others, so a core that moved one of them cannot ship half a fix.
    await writeFile(file, PI_HANDLER_2026_831_1);
    await expect(applyPatches(root, PATCHES)).rejects.toThrow(/onboarding-skip-harness-handler.*matched 0 time\(s\)/);
  });

  it("dry-run reports without touching the file", async () => {
    const file = path.join(root, "ui/dist/assets/index-BHbrFFmp.js");
    await writeFile(file, FULL_BUNDLE_2026_831_1);
    const report = await applyPatches(root, PATCHES, { dryRun: true });
    expect(report.map((entry) => entry.matched)).toEqual(PATCHES.map(() => 1));
    expect(await readFile(file, "utf8")).toBe(FULL_BUNDLE_2026_831_1);
  });
});
