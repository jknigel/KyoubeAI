import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPatches, applyToText, expandGlob } from "../lib.mjs";
import { PATCHES } from "../patches.mjs";

// The message_end handler exactly as core 2026.831.1's minified UI bundle
// carries it (ui/dist/assets/index-BHbrFFmp.js), with the branches on
// either side so the pattern is proven to anchor on this handler alone.
const PI_HANDLER_2026_831_1 =
  'if(r==="message_start")return[];if(r==="message_update"){const i=uS(n.assistantMessageEvent);if(i){const a=sf(i.type);if(a==="text_end"){const o=sf(i.content);if(o)return[{kind:"assistant",ts:t,text:o}]}}return[]}' +
  'if(r==="message_end"){const i=uS(n.message);if(i){const a=i.content,{text:o,thinking:l}=hS(a),c=[];return l&&c.push({kind:"thinking",ts:t,text:l}),o&&c.push({kind:"assistant",ts:t,text:o}),c}return[]}' +
  'if(r==="tool_execution_start"){const i=sf(n.toolCallId,`tool-${Date.now()}`);return[{kind:"tool_call",ts:t,name:"x",toolUseId:i}]}';

const piPatch = PATCHES.find((patch) => patch.id === "pi-transcript-non-assistant-messages");

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
    await writeFile(file, `const x=1;${PI_HANDLER_2026_831_1};const y=2;`);
    const report = await applyPatches(root, PATCHES);
    expect(report).toEqual([{ id: "pi-transcript-non-assistant-messages", matched: 1, expect: 1, files: ["ui/dist/assets/index-BHbrFFmp.js"] }]);
    expect(await readFile(file, "utf8")).toContain('.role!=="assistant")return[]');
  });

  it("fails — without writing — when a patch matches zero times or more than declared", async () => {
    const file = path.join(root, "ui/dist/assets/index-BHbrFFmp.js");
    await writeFile(file, "nothing here");
    await expect(applyPatches(root, PATCHES)).rejects.toThrow(/matched 0 time\(s\).*expected 1/);
    await writeFile(file, PI_HANDLER_2026_831_1 + PI_HANDLER_2026_831_1);
    await expect(applyPatches(root, PATCHES)).rejects.toThrow(/matched 2 time\(s\).*expected 1/);
  });

  it("dry-run reports without touching the file", async () => {
    const file = path.join(root, "ui/dist/assets/index-BHbrFFmp.js");
    await writeFile(file, PI_HANDLER_2026_831_1);
    const report = await applyPatches(root, PATCHES, { dryRun: true });
    expect(report[0].matched).toBe(1);
    expect(await readFile(file, "utf8")).toBe(PI_HANDLER_2026_831_1);
  });
});
