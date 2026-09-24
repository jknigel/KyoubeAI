import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPatches, applyToText, expandGlob } from "../lib.mjs";
import { PATCHES, SKIP_HARNESS_LABEL } from "../patches.mjs";

// Excerpts of core 2026.916.1's minified UI, copied verbatim. The pi parser
// lives in a code-split chunk (AiConnectionCredentialStep-DHV6zd1f.js); the
// onboarding wizard in the main bundle (index-5zyW-AFc.js).

// The message_update / message_end / tool_execution_start branches of the pi
// transcript parser, so the pattern is proven to anchor on message_end alone.
const PI_HANDLER_2026_916_1 =
  'if(r==="message_start")return[];if(r==="message_update"){const s=hn(n.assistantMessageEvent);if(s){const o=tt(s.type);if(o==="thinking_delta"){const a=tt(s.delta);if(a)return[{kind:"thinking",ts:t,text:a,delta:!0}]}if(o==="text_delta"){const a=tt(s.delta);if(a)return[{kind:"assistant",ts:t,text:a,delta:!0}]}if(o==="thinking_end"){const a=tt(s.content);if(a)return[{kind:"thinking",ts:t,text:a}]}if(o==="text_end"){const a=tt(s.content);if(a)return[{kind:"assistant",ts:t,text:a}]}}return[]}' +
  'if(r==="message_end"){const s=hn(n.message);if(s){const o=s.content,{text:a,thinking:l}=gn(o),c=[];return l&&c.push({kind:"thinking",ts:t,text:l}),a&&c.push({kind:"assistant",ts:t,text:a}),c}return[]}' +
  'if(r==="tool_execution_start"){return[{kind:"tool_call",ts:t,name:"x"}]}';

// The Connect step's primary action (`handleConnectStepPrimary`).
const CONNECT_PRIMARY_2026_916_1 =
  'function pn(){if(Je==="ready"&&Ft){It&&window.open(It,"_blank","noreferrer,noopener"),qe("waiting");return}Je!=="connecting"&&(zs||ma())}';

// The subscription sign-in inside the hire handler (`handleGiveHeartbeat`, `ma`).
const LOCAL_LOGIN_2026_916_1 =
  'if(Le!=="api"&&vr&&gt&&!lt()&&!bt&&!Oe.storedLogin.data){if(await qn.connect(),!es())return;ze.current={companyId:$e,binding:{provider:gt,method:"subscription",mode:"responsible_user"}}}';

// The environment-test gate further down the same handler.
const ENV_GATE_2026_916_1 =
  'if(ct){const pr=(De&&Wt.current===yr&&!sH(De)?De:null)??await wn(Sa,yr,es);if(!pr||!es())return;if(sH(pr)){P(pr.status==="fail"?"The environment test failed. Fix the reported checks before you hire this agent.":"No working authentication was found. Fix the reported checks before you hire this agent.");return}}';

// The wizard's error line followed by its footer navigation: two array
// children of the step body.
const ERROR_AND_FOOTER_2026_916_1 =
  'tn&&(0,t.jsx)("div",{className:"mt-3",children:(0,t.jsx)("p",{className:"text-xs text-destructive",children:tn})}),' +
  '(Y||_===1)&&(0,t.jsx)(Pwe,{onBack:_===4&&Je!=="idle"?Vs:Mze({currentStep:_,entryStep:S})?()=>I(Ha(_)):void 0,primaryLabel:_===1?"Continue":_===5?"Get started":_===4?Hn.label:"Next",primaryIcon:_===4?Hn.icon:void 0,loadingLabel:_===1?"Creating...":_===4?"Connecting":"Launching...",loading:_===3||_===4?!1:B,primaryDisabled:_===1?!M.trim()||B:_===3?!H.trim():_===4?Hn.disabled||B:B||en,onPrimary:()=>{_===1?kr():_===3?I(4):_===4?pn():Gn()}})';

const patch = (id) => PATCHES.find((entry) => entry.id === id);
const piPatch = patch("pi-transcript-non-assistant-messages");
const primaryPatch = patch("onboarding-skip-harness-primary");
const loginPatch = patch("onboarding-skip-harness-login");
const gatePatch = patch("onboarding-skip-harness-gate");
const buttonPatch = patch("onboarding-skip-harness-button");

/** A bundle fragment carrying every region the declared patches target, once each. */
const FULL_BUNDLE_2026_916_1 =
  `const x=1;${PI_HANDLER_2026_916_1};${CONNECT_PRIMARY_2026_916_1}` +
  `async function ma(){try{${LOCAL_LOGIN_2026_916_1}${ENV_GATE_2026_916_1}}catch{}}const y=[${ERROR_AND_FOOTER_2026_916_1}];`;

function declaredSafely(entry) {
  expect(entry).toBeDefined();
  expect(entry.upstream).toContain("github.com/paperclipai/paperclip");
  expect(entry.expect).toBe(1);
  expect(entry.pattern.flags).toContain("g");
}

/** Runs the (patched or unpatched) pi handler as the parser would, with the minified helpers stubbed. */
function runPiHandler(code, message) {
  const hn = (value) => (typeof value === "object" && value !== null && !Array.isArray(value) ? value : null);
  const tt = (value, fallback = "") => (typeof value === "string" ? value : fallback);
  const gn = (content) => ({ text: content.filter((c) => c.type === "text").map((c) => c.text).join(""), thinking: "" });
  const fn = new Function("r", "n", "t", "hn", "tt", "gn", `${code};return "fell-through"`);
  return fn("message_end", { message }, "2026-09-24T00:00:00Z", hn, tt, gn);
}

describe("pi-transcript-non-assistant-messages", () => {
  it("is declared with the safety fields every patch needs", () => declaredSafely(piPatch));

  it("looks in every chunk, since the parser moved out of the main bundle", () => {
    expect(piPatch.files).toEqual(["ui/dist/assets/*.js"]);
  });

  it("matches the 2026.916.1 handler exactly once, whatever the minifier called the identifiers", () => {
    const { count, text } = applyToText(PI_HANDLER_2026_916_1, piPatch);
    expect(count).toBe(1);
    expect(text).toContain('if(r==="message_end"){const s=hn(n.message);if(s&&s.role!=="assistant")return[];if(s){');
    const renamed = PI_HANDLER_2026_916_1.replaceAll("hn(", "Qx(").replaceAll("const s=", "const Z=").replaceAll("if(s){", "if(Z){").replaceAll("s.content", "Z.content");
    expect(applyToText(renamed, piPatch).count).toBe(1);
  });

  it("does not match again once applied, so a core that already carries the fix fails the build", () => {
    const once = applyToText(PI_HANDLER_2026_916_1, piPatch).text;
    expect(applyToText(once, piPatch).count).toBe(0);
  });

  it("keeps the assistant's text and drops the wake prompt and tool results — proven by running the patched code", () => {
    const text = (s) => [{ type: "text", text: s }];
    const before = PI_HANDLER_2026_916_1;
    const after = applyToText(before, piPatch).text;
    expect(runPiHandler(before, { role: "user", content: text("## KyoubeAI Resume Delta") })).toEqual([{ kind: "assistant", ts: "2026-09-24T00:00:00Z", text: "## KyoubeAI Resume Delta" }]);
    expect(runPiHandler(before, { role: "toolResult", content: text("=== doc revisions ===") })).toHaveLength(1);
    expect(runPiHandler(after, { role: "user", content: text("## KyoubeAI Resume Delta") })).toEqual([]);
    expect(runPiHandler(after, { role: "toolResult", content: text("=== doc revisions ===") })).toEqual([]);
    expect(runPiHandler(after, { role: "assistant", content: text("Done — the pack is sent.") })).toEqual([{ kind: "assistant", ts: "2026-09-24T00:00:00Z", text: "Done — the pack is sent." }]);
    expect(runPiHandler(after, null)).toEqual([]);
  });
});

/** Runs the (patched or unpatched) Connect primary action with the wizard's state stubbed. */
function runConnectPrimary(code, { phase = "idle", needsLogin = false, loggingIn = false, arg } = {}) {
  const calls = { hires: [], opened: [], phases: [] };
  const window = { open: (...args) => calls.opened.push(args) };
  const pn = new Function("Je", "Ft", "It", "qe", "zs", "ma", "window", `${code};return pn`)(
    phase, needsLogin, "https://claude.example/auth", (next) => calls.phases.push(next), loggingIn,
    (...args) => { calls.hires.push(args); }, window,
  );
  if (arg === undefined) pn(); else pn(arg);
  return calls;
}

describe("onboarding-skip-harness-primary", () => {
  it("is declared with the safety fields every patch needs", () => declaredSafely(primaryPatch));

  it("matches the 2026.916.1 primary action exactly once, whatever the minifier called the identifiers", () => {
    const { count, text } = applyToText(CONNECT_PRIMARY_2026_916_1, primaryPatch);
    expect(count).toBe(1);
    expect(text).toContain("function pn(){if(arguments[0]===!0){ma(!0);return}");
    const renamed = CONNECT_PRIMARY_2026_916_1.replaceAll("Je", "$q").replaceAll("ma()", "Zz()").replaceAll("pn", "Aa");
    expect(applyToText(renamed, primaryPatch).count).toBe(1);
  });

  it("does not match again once applied", () => {
    const once = applyToText(CONNECT_PRIMARY_2026_916_1, primaryPatch).text;
    expect(applyToText(once, primaryPatch).count).toBe(0);
  });

  it("hands an explicit `true` straight to the hire handler, and otherwise behaves as before — proven by running the patched code", () => {
    const after = applyToText(CONNECT_PRIMARY_2026_916_1, primaryPatch).text;
    // The skip goes to the hire, even mid sign-in.
    expect(runConnectPrimary(after, { arg: true, phase: "ready", needsLogin: true }).hires).toEqual([[true]]);
    expect(runConnectPrimary(after, { arg: true, phase: "connecting" }).hires).toEqual([[true]]);
    // No argument: upstream's behaviour, unchanged.
    expect(runConnectPrimary(after, {}).hires).toEqual([[]]);
    const signIn = runConnectPrimary(after, { phase: "ready", needsLogin: true });
    expect(signIn.hires).toEqual([]);
    expect(signIn.opened).toHaveLength(1);
    expect(signIn.phases).toEqual(["waiting"]);
    expect(runConnectPrimary(after, { phase: "connecting" }).hires).toEqual([]);
    expect(runConnectPrimary(after, { loggingIn: true }).hires).toEqual([]);
    // A click event is not a skip.
    expect(runConnectPrimary(after, { arg: { type: "click" } }).hires).toEqual([[]]);
  });
});

/** Runs the (patched or unpatched) sign-in block inside a plain async function, as the hire handler holds it. */
async function runLocalLogin(code, { mode = "subscription", arg } = {}) {
  const calls = { connects: 0 };
  const fn = new Function(
    "Le", "vr", "gt", "lt", "bt", "Oe", "qn", "es", "ze", "$e",
    `return async function ma(){${code}return "hired"}`,
  )(
    mode, true, "anthropic", () => null, null, { storedLogin: { data: null } },
    { connect: async () => { calls.connects += 1; throw new Error("Only the local operator can connect this machine's CLI account."); } },
    () => true, { current: null }, "company-1",
  );
  let outcome;
  try { outcome = arg === undefined ? await fn() : await fn(arg); } catch (error) { outcome = `threw: ${error.message}`; }
  return { ...calls, outcome };
}

describe("onboarding-skip-harness-login", () => {
  it("is declared with the safety fields every patch needs", () => declaredSafely(loginPatch));

  it("matches the 2026.916.1 sign-in block exactly once, whatever the minifier called the identifiers", () => {
    const { count, text } = applyToText(LOCAL_LOGIN_2026_916_1, loginPatch);
    expect(count).toBe(1);
    expect(text).toContain('if(arguments[0]!==!0&&Le!=="api"&&vr&&gt&&!lt()&&!bt&&!Oe.storedLogin.data){if(await qn.connect(),');
    const renamed = LOCAL_LOGIN_2026_916_1.replaceAll("Le", "$k").replaceAll("qn.", "Ww.").replaceAll("Oe.", "Uu.");
    expect(applyToText(renamed, loginPatch).count).toBe(1);
  });

  it("does not match again once applied", () => {
    const once = applyToText(LOCAL_LOGIN_2026_916_1, loginPatch).text;
    expect(applyToText(once, loginPatch).count).toBe(0);
  });

  it("skips the sign-in only on an explicit `true` — proven by running the patched code", async () => {
    const after = applyToText(LOCAL_LOGIN_2026_916_1, loginPatch).text;
    const blocked = await runLocalLogin(LOCAL_LOGIN_2026_916_1);
    expect(blocked).toEqual({ connects: 1, outcome: "threw: Only the local operator can connect this machine's CLI account." });
    expect(await runLocalLogin(after)).toEqual(blocked);
    expect(await runLocalLogin(after, { arg: { type: "click" } })).toEqual(blocked);
    expect(await runLocalLogin(after, { arg: true })).toEqual({ connects: 0, outcome: "hired" });
    // An API key never signs in, skip or not.
    expect(await runLocalLogin(after, { mode: "api" })).toEqual({ connects: 0, outcome: "hired" });
  });
});

/** Runs the (patched or unpatched) environment gate inside a plain async function, as the hire handler holds it. */
async function runEnvGate(code, { envResult, arg } = {}) {
  const calls = { probes: 0, errors: [] };
  const blocks = (result) => result.status === "fail" || result.authMissing === true;
  const fn = new Function(
    "ct", "De", "Wt", "yr", "sH", "wn", "Sa", "es", "P",
    `return async function ma(){${code}return "hired"}`,
  )(
    true, null, { current: false }, false, blocks,
    async () => { calls.probes += 1; return envResult; }, {}, () => true, (message) => calls.errors.push(message),
  );
  const outcome = arg === undefined ? await fn() : await fn(arg);
  return { ...calls, outcome };
}

describe("onboarding-skip-harness-gate", () => {
  it("is declared with the safety fields every patch needs", () => declaredSafely(gatePatch));

  it("matches the 2026.916.1 gate exactly once, whatever the minifier called the identifiers", () => {
    const { count, text } = applyToText(ENV_GATE_2026_916_1, gatePatch);
    expect(count).toBe(1);
    expect(text).toContain("if(ct&&arguments[0]!==!0){const pr=(De&&Wt.current===yr&&!sH(De)?De:null)??await wn(Sa,yr,es);");
    // Upstream's own messages are kept.
    expect(text).toContain('"The environment test failed. Fix the reported checks before you hire this agent."');
    const renamed = ENV_GATE_2026_916_1.replaceAll("ct", "$c").replaceAll("pr", "Rr").replaceAll("sH(", "Ss(").replaceAll("P(", "Pp(");
    expect(applyToText(renamed, gatePatch).count).toBe(1);
  });

  it("does not match again once applied", () => {
    const once = applyToText(ENV_GATE_2026_916_1, gatePatch).text;
    expect(applyToText(once, gatePatch).count).toBe(0);
  });

  it("still blocks a failed probe, and skips the probe only on an explicit `true` — proven by running the patched code", async () => {
    const after = applyToText(ENV_GATE_2026_916_1, gatePatch).text;
    const fail = { status: "fail" };
    const before = await runEnvGate(ENV_GATE_2026_916_1, { envResult: fail });
    expect(before).toEqual({ probes: 1, errors: ["The environment test failed. Fix the reported checks before you hire this agent."], outcome: undefined });
    expect(await runEnvGate(after, { envResult: fail })).toEqual(before);
    expect(await runEnvGate(after, { envResult: fail, arg: { type: "click" } })).toEqual(before);
    expect(await runEnvGate(after, { envResult: { status: "warn", authMissing: true } })).toEqual({ probes: 1, errors: ["No working authentication was found. Fix the reported checks before you hire this agent."], outcome: undefined });
    expect(await runEnvGate(after, { envResult: fail, arg: true })).toEqual({ probes: 0, errors: [], outcome: "hired" });
    expect(await runEnvGate(after, { envResult: { status: "pass" } })).toEqual({ probes: 1, errors: [], outcome: "hired" });
  });
});

/** Evaluates the (patched or unpatched) error+footer children with the wizard's render scope stubbed. */
function renderErrorAndFooter(code, { step, error, loading = false }) {
  const t = { jsx: (type, props) => ({ type, props }) };
  const primaryCalls = [];
  const fn = new Function(
    "t", "tn", "Y", "Pwe", "Je", "Vs", "Mze", "I", "Ha", "_", "S", "Hn", "B", "M", "H", "en", "kr", "pn", "Gn",
    `return [${code}]`,
  );
  const children = fn(
    t, error, true, "FooterNav", "idle", () => {}, () => true, () => {}, (n) => n - 1, step, 3,
    { label: "Connect", icon: "arrow", disabled: false }, loading, { trim: () => "Co" }, { trim: () => "Ada" }, false,
    () => {}, (...args) => { primaryCalls.push(args); }, () => {},
  );
  return { children, primaryCalls };
}

describe("onboarding-skip-harness-button", () => {
  it("is declared with the safety fields every patch needs", () => declaredSafely(buttonPatch));

  it("matches the 2026.916.1 error line and footer exactly once, whatever the minifier called the identifiers", () => {
    const { count, text } = applyToText(ERROR_AND_FOOTER_2026_916_1, buttonPatch);
    expect(count).toBe(1);
    expect(text).toContain('_===4&&tn&&(0,t.jsx)("div",{className:"mt-2"');
    expect(text).toContain("onClick:()=>pn(!0)");
    // The footer call is re-emitted untouched.
    expect(text).toContain(ERROR_AND_FOOTER_2026_916_1.slice(ERROR_AND_FOOTER_2026_916_1.indexOf("(Y||")));
    const renamed = ERROR_AND_FOOTER_2026_916_1.replaceAll("tn", "$e").replaceAll("(0,t.jsx)", "(0,Kt.jsx)").replaceAll("pn()", "Qq()").replaceAll("_===", "St===").replaceAll("currentStep:_", "currentStep:St").replaceAll("Ha(_)", "Ha(St)");
    expect(applyToText(renamed, buttonPatch).count).toBe(1);
  });

  it("does not match again once applied", () => {
    const once = applyToText(ERROR_AND_FOOTER_2026_916_1, buttonPatch).text;
    expect(applyToText(once, buttonPatch).count).toBe(0);
  });

  it("renders the skip control only on step 4 under an error, and it calls the primary action with `true` — proven by running the patched code", () => {
    const after = applyToText(ERROR_AND_FOOTER_2026_916_1, buttonPatch).text;
    const message = "Could not verify the local subscription. Run the sign-in command shown for this connection, finish signing in, then try Connect again.";
    const before = renderErrorAndFooter(ERROR_AND_FOOTER_2026_916_1, { step: 4, error: message });
    expect(before.children).toHaveLength(2);
    expect(before.children[1].type).toBe("FooterNav");

    const shown = renderErrorAndFooter(after, { step: 4, error: message });
    expect(shown.children).toHaveLength(3);
    expect(shown.children[0].props.children.props.children).toBe(message);
    const button = shown.children[1].props.children;
    expect(button.type).toBe("button");
    expect(button.props.type).toBe("button");
    expect(button.props.children).toBe(SKIP_HARNESS_LABEL);
    expect(button.props.disabled).toBe(false);
    button.props.onClick();
    expect(shown.primaryCalls).toEqual([[true]]);
    expect(shown.children[2].type).toBe("FooterNav");
    expect(shown.children[2].props.primaryLabel).toBe("Connect");

    // Any other step, or no error: the slot is falsy, so React renders nothing there.
    expect(renderErrorAndFooter(after, { step: 3, error: message }).children[1]).toBeFalsy();
    expect(renderErrorAndFooter(after, { step: 5, error: message }).children[1]).toBeFalsy();
    expect(renderErrorAndFooter(after, { step: 4, error: null }).children[0]).toBeFalsy();
    expect(renderErrorAndFooter(after, { step: 4, error: null }).children[1]).toBeFalsy();
    // While a hire is in flight the control is disabled.
    expect(renderErrorAndFooter(after, { step: 4, error: message, loading: true }).children[1].props.children.props.disabled).toBe(true);
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
    expect((await expandGlob(root, "ui/dist/assets/*.js")).map((f) => path.basename(f))).toEqual(["index-AAAA.js", "other-BBBB.js"]);
    expect(await expandGlob(root, "nope/*.js")).toEqual([]);
  });

  it("rewrites the bundle in place and reports it", async () => {
    const file = path.join(root, "ui/dist/assets/index-5zyW-AFc.js");
    await writeFile(file, FULL_BUNDLE_2026_916_1);
    const report = await applyPatches(root, PATCHES);
    expect(report).toEqual(PATCHES.map((entry) => ({ id: entry.id, matched: 1, expect: 1, files: ["ui/dist/assets/index-5zyW-AFc.js"] })));
    const patched = await readFile(file, "utf8");
    expect(patched).toContain('.role!=="assistant")return[]');
    expect(patched).toContain("arguments[0]!==!0");
    expect(patched).toContain(SKIP_HARNESS_LABEL);
  });

  it("finds the pi parser in a code-split chunk", async () => {
    await writeFile(path.join(root, "ui/dist/assets/index-5zyW-AFc.js"), FULL_BUNDLE_2026_916_1.replace(PI_HANDLER_2026_916_1, ""));
    await writeFile(path.join(root, "ui/dist/assets/AiConnectionCredentialStep-DHV6zd1f.js"), PI_HANDLER_2026_916_1);
    const report = await applyPatches(root, PATCHES);
    expect(report.find((entry) => entry.id === piPatch.id).files).toEqual(["ui/dist/assets/AiConnectionCredentialStep-DHV6zd1f.js"]);
  });

  it("fails — without writing — when a patch matches zero times or more than declared", async () => {
    const file = path.join(root, "ui/dist/assets/index-5zyW-AFc.js");
    await writeFile(file, "nothing here");
    await expect(applyPatches(root, PATCHES)).rejects.toThrow(/matched 0 time\(s\).*expected 1/);
    await writeFile(file, FULL_BUNDLE_2026_916_1 + FULL_BUNDLE_2026_916_1);
    await expect(applyPatches(root, PATCHES)).rejects.toThrow(/matched 2 time\(s\).*expected 1/);
    // A bundle that carries only one region still fails the build on the
    // others, so a core that moved one of them cannot ship half a fix.
    await writeFile(file, PI_HANDLER_2026_916_1);
    await expect(applyPatches(root, PATCHES)).rejects.toThrow(/onboarding-skip-harness-primary.*matched 0 time\(s\)/);
  });

  it("dry-run reports without touching the file", async () => {
    const file = path.join(root, "ui/dist/assets/index-5zyW-AFc.js");
    await writeFile(file, FULL_BUNDLE_2026_916_1);
    const report = await applyPatches(root, PATCHES, { dryRun: true });
    expect(report.map((entry) => entry.matched)).toEqual(PATCHES.map(() => 1));
    expect(await readFile(file, "utf8")).toBe(FULL_BUNDLE_2026_916_1);
  });
});
