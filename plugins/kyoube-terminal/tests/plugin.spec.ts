import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk/protocol";
import manifest from "../src/manifest.js";
import { createTerminalPlugin, DEFAULT_WAIT_MS, MAX_WAIT_MS, resolveWaitTimeoutMs, type TerminalPluginDeps } from "../src/plugin.js";
import { fakeSpawner, type FakePty } from "./fake-pty.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const ADMIN = { type: "user" as const, userId: "admin-1" };
const MEMBER = { type: "user" as const, userId: "member-1" };

const MEMBERS = [
  { id: "m1", companyId: COMPANY, principalType: "user" as const, principalId: "admin-1", status: "active" as const, membershipRole: "admin", grants: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" },
  { id: "m2", companyId: COMPANY, principalType: "user" as const, principalId: "member-1", status: "active" as const, membershipRole: "member", grants: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" },
  // The same admin is also an admin of a second company, so a cross-company call fails on the
  // session's company binding rather than on the role gate.
  { id: "m3", companyId: OTHER_COMPANY, principalType: "user" as const, principalId: "admin-1", status: "active" as const, membershipRole: "admin", grants: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" },
];

const KYOUBE_CONFIG = { home: "/kyoubeai", hermesHome: "/kyoubeai/.hermes", dataDatabaseUrl: "postgres://x", publicUrl: "http://localhost:3100", paperclipApiUrl: "http://127.0.0.1:3100" };

async function setup(config: Record<string, unknown> = {}, deps: Partial<TerminalPluginDeps> = {}, spawner = fakeSpawner()) {
  const harness = createTestHarness({ manifest, config });
  harness.seed({ accessMembers: MEMBERS });
  const ctx = harness.ctx;
  let counter = 0;
  const plugin = createTerminalPlugin({
    createSpawner: () => spawner.spawn,
    loadKyoubeConfig: async () => KYOUBE_CONFIG,
    randomId: () => `id${++counter}`,
    sweepIntervalMs: 0,
    ...deps,
  });
  await plugin.definition.setup(ctx);
  const act = <T,>(key: string, params: Record<string, unknown>, actor = ADMIN) =>
    harness.performAction<T>(key, params, { actor, companyId: COMPANY });
  return { harness, plugin, spawner, act, pty: () => spawner.ptys[0] as FakePty };
}

type ActionHandler = (params: Record<string, unknown>, context: PluginPerformActionContext) => Promise<unknown>;

/**
 * Same plugin, but the action handlers are captured directly so a test can hand them a
 * `PluginPerformActionContext` the harness cannot build — specifically a company-scoped call
 * that still carries a *different* `params.companyId`, which the harness always resolves into
 * the context before the handler sees it.
 */
async function setupRaw() {
  const harness = createTestHarness({ manifest, config: {} });
  harness.seed({ accessMembers: MEMBERS });
  const spawner = fakeSpawner();
  const handlers = new Map<string, ActionHandler>();
  const ctx = {
    ...harness.ctx,
    actions: { register: (key: string, handler: ActionHandler) => void handlers.set(key, handler) },
  };
  let counter = 0;
  const plugin = createTerminalPlugin({
    createSpawner: () => spawner.spawn,
    loadKyoubeConfig: async () => KYOUBE_CONFIG,
    randomId: () => `id${++counter}`,
    sweepIntervalMs: 0,
  });
  await plugin.definition.setup(ctx);
  const context = (companyId: string | null): PluginPerformActionContext => ({
    actor: { type: "user", userId: "admin-1", agentId: null, runId: null, companyId },
    companyId,
  });
  return { harness, call: (key: string, params: Record<string, unknown>, ctxCompanyId: string) => handlers.get(key)!(params, context(ctxCompanyId)) };
}

describe("kyoube.terminal actions", () => {
  it("opens a session for an allowed role, delivers output through wait, and attaches with replay", async () => {
    const { act, pty } = await setup();
    const opened = await act<{ sessionId: string }>("terminal.open", { cols: 100, rows: 30 });
    expect(opened.sessionId).toBe("term-id1");
    expect(pty().request).toEqual({ shell: "/bin/bash", cols: 100, rows: 30 });
    const waiting = act<{ events: unknown[] }>("terminal.wait", { sessionId: opened.sessionId, afterSeq: 0, timeoutMs: 5_000 });
    // Let the action get through `authorize` and park before the shell produces anything, so
    // this exercises the parked path end to end rather than the answer-at-once path.
    await new Promise((resolve) => setTimeout(resolve, 25));
    pty().emitData("$ ");
    // Output is coalesced on a ~16 ms window (spec §7) before the parked wait is answered.
    expect((await waiting).events).toEqual([{ seq: 1, type: "output", data: "$ " }]);
    await act("terminal.input", { sessionId: opened.sessionId, data: "ls\n" });
    expect(pty().written).toEqual(["ls\n"]);
    const attached = await act<{ events: unknown[]; truncated: boolean }>("terminal.attach", { sessionId: opened.sessionId, afterSeq: 0 });
    expect(attached.events).toEqual([{ seq: 1, type: "output", data: "$ " }]);
  });

  it("denies members, agents, and anonymous callers and audits denials", async () => {
    const { act, harness } = await setup();
    await expect(act("terminal.open", {}, MEMBER)).rejects.toThrow("forbidden");
    await expect(act("terminal.open", {}, { type: "agent" as const, agentId: "a1" } as never)).rejects.toThrow("forbidden");
    expect(harness.activity.some((entry) => entry.message.includes("denied"))).toBe(true);
  });

  it("denies a system (unattributed) actor with forbidden and audits it", async () => {
    const { harness } = await setup();
    // No actor at all: the host defaults the actor type to `system`, which has no board user.
    await expect(harness.performAction("terminal.open", {}, { companyId: COMPANY })).rejects.toThrow("forbidden");
    const denial = harness.activity.find((entry) => entry.message.includes("not a signed-in user"));
    expect(denial?.metadata).toMatchObject({ actorType: "system" });
  });

  it("rejects a params.companyId that contradicts the host's company scope", async () => {
    const { call } = await setupRaw();
    await expect(call("terminal.open", { companyId: OTHER_COMPANY }, COMPANY)).rejects.toThrow("invalid");
    // The matching value is still accepted (the production bridge injects exactly this).
    await expect(call("terminal.open", { companyId: COMPANY }, COMPANY)).resolves.toMatchObject({ sessionId: expect.any(String) });
  });

  it("rejects an input payload larger than 1 MiB", async () => {
    const { act, pty } = await setup();
    const opened = await act<{ sessionId: string }>("terminal.open", {});
    await expect(act("terminal.input", { sessionId: opened.sessionId, data: "x".repeat(1024 * 1024 + 1) })).rejects.toThrow("invalid");
    await expect(act("terminal.input", { sessionId: opened.sessionId, data: "x".repeat(1024 * 1024) })).resolves.toEqual({ ok: true });
    expect(pty().written).toHaveLength(1); // only the accepted payload reached the shell
  });

  it("applies the scrollbackKb setting to the session's replay buffer", async () => {
    const { act, pty } = await setup({ scrollbackKb: 16 });
    const opened = await act<{ sessionId: string }>("terminal.open", {});
    pty().emitData("x".repeat(100_000)); // well past a 16 KiB scrollback, and past one event's cap
    const attached = await act<{ events: Array<{ seq: number }>; truncated: boolean }>("terminal.attach", { sessionId: opened.sessionId, afterSeq: 0 });
    expect(attached.truncated).toBe(true);
    expect(attached.events).toHaveLength(1); // the oldest chunk was trimmed out of the buffer
  });

  it("terminal.wait answers as soon as output arrives", async () => {
    const { act, pty } = await setup();
    const opened = await act<{ sessionId: string }>("terminal.open", {});
    const waiting = act<{ events: unknown[]; session: { alive: boolean } }>("terminal.wait", { sessionId: opened.sessionId, afterSeq: 0, timeoutMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 25)); // park first (see the first test)
    pty().emitData("$ ");
    const result = await waiting;
    expect(result.events).toEqual([{ seq: 1, type: "output", data: "$ " }]);
    expect(result.session.alive).toBe(true);
  });

  it("terminal.wait answers empty within its timeout when nothing arrives", async () => {
    const { act } = await setup();
    const opened = await act<{ sessionId: string }>("terminal.open", {});
    const started = Date.now();
    const result = await act<{ events: unknown[] }>("terminal.wait", { sessionId: opened.sessionId, afterSeq: 0, timeoutMs: 30 });
    expect(result.events).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("terminal.wait is gated like the other session actions", async () => {
    const { act, harness } = await setup();
    const opened = await act<{ sessionId: string }>("terminal.open", {});
    await expect(act("terminal.wait", { sessionId: opened.sessionId, afterSeq: 0, timeoutMs: 0 }, MEMBER)).rejects.toThrow("forbidden");
    await expect(harness.performAction("terminal.wait", { sessionId: opened.sessionId, afterSeq: 0, timeoutMs: 0 }, { actor: ADMIN, companyId: OTHER_COMPANY })).rejects.toThrow("not_found");
  });

  it("clamps the wait timeout so a poll always answers before the host's RPC timeout", () => {
    expect(resolveWaitTimeoutMs(undefined)).toBe(DEFAULT_WAIT_MS);
    expect(resolveWaitTimeoutMs(2_500)).toBe(2_500);
    expect(resolveWaitTimeoutMs(0)).toBe(0);
    expect(resolveWaitTimeoutMs(-5)).toBe(0);
    expect(resolveWaitTimeoutMs(999_999)).toBe(MAX_WAIT_MS);
    expect(MAX_WAIT_MS).toBeLessThan(30_000); // upstream DEFAULT_RPC_TIMEOUT_MS
    expect(() => resolveWaitTimeoutMs("soon")).toThrow("invalid");
  });

  it("hides another company's session from attach and kill", async () => {
    const { act, harness } = await setup();
    const opened = await act<{ sessionId: string }>("terminal.open", {});
    const fromOtherCompany = (key: string, params: Record<string, unknown>) =>
      harness.performAction(key, params, { actor: ADMIN, companyId: OTHER_COMPANY });
    await expect(fromOtherCompany("terminal.kill", { sessionId: opened.sessionId })).rejects.toThrow("not_found");
    await expect(fromOtherCompany("terminal.attach", { sessionId: opened.sessionId, afterSeq: 0 })).rejects.toThrow("not_found");
    await expect(fromOtherCompany("terminal.input", { sessionId: opened.sessionId, data: "x" })).rejects.toThrow("not_found");
    await expect(fromOtherCompany("terminal.close", { sessionId: opened.sessionId })).rejects.toThrow("not_found");
    // The session is untouched: its own company can still attach to it.
    await expect(act("terminal.attach", { sessionId: opened.sessionId, afterSeq: 0 })).resolves.toMatchObject({ session: { alive: true } });
  });

  it("rethrows a non-forbidden error from the role lookup without auditing a denial", async () => {
    const harness = createTestHarness({ manifest, config: {} });
    harness.seed({
      accessMembers: [
        { id: "m1", companyId: COMPANY, principalType: "user", principalId: "admin-1", status: "active", membershipRole: "admin", grants: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" },
      ],
    });
    const spawner = fakeSpawner();
    const listError = new Error("members service unavailable");
    const ctx = {
      ...harness.ctx,
      access: {
        ...harness.ctx.access,
        members: {
          ...harness.ctx.access.members,
          list: async () => {
            throw listError;
          },
        },
      },
    };
    const plugin = createTerminalPlugin({
      createSpawner: () => spawner.spawn,
      loadKyoubeConfig: async () => ({ home: "/kyoubeai", hermesHome: "/kyoubeai/.hermes", dataDatabaseUrl: "postgres://x", publicUrl: "http://localhost:3100", paperclipApiUrl: "http://127.0.0.1:3100" }),
      randomId: () => "idX",
      sweepIntervalMs: 0,
    });
    await plugin.definition.setup(ctx);
    await expect(harness.performAction("terminal.open", {}, { actor: ADMIN, companyId: COMPANY })).rejects.toThrow("members service unavailable");
    expect(harness.activity.some((entry) => entry.message.includes("denied"))).toBe(false);
  });

  it("honours allowedRoles from plugin config", async () => {
    const { act } = await setup({ allowedRoles: ["owner", "admin", "member"] });
    await expect(act("terminal.open", {}, MEMBER)).resolves.toMatchObject({ sessionId: expect.any(String) });
  });

  it("uses the configured shell and enforces the per-user limit", async () => {
    const { act, spawner } = await setup({ shell: "/bin/sh", maxSessionsPerUser: 1 });
    await act("terminal.open", {});
    expect(spawner.ptys[0]?.request.shell).toBe("/bin/sh");
    await expect(act("terminal.open", {})).rejects.toThrow("limit");
  });

  it("lists sessions for the company, closes own sessions, and lets admins kill any session", async () => {
    const { act, spawner } = await setup({ allowedRoles: ["admin", "member"] });
    const mine = await act<{ sessionId: string }>("terminal.open", {});
    const theirs = await act<{ sessionId: string }>("terminal.open", {}, MEMBER);
    const listed = await act<{ sessions: Array<{ id: string; ownerUserId: string }> }>("terminal.list", {});
    expect(listed.sessions.map((s) => s.ownerUserId).sort()).toEqual(["admin-1", "member-1"]);
    await expect(act("terminal.close", { sessionId: theirs.sessionId })).rejects.toThrow("forbidden");
    await act("terminal.kill", { sessionId: theirs.sessionId });
    await act("terminal.close", { sessionId: mine.sessionId });
    expect(spawner.ptys.every((pty) => pty.killed !== null)).toBe(true);
  });

  it("records session open and close in the activity log without content", async () => {
    const { act, harness } = await setup();
    const opened = await act<{ sessionId: string }>("terminal.open", {});
    await act("terminal.input", { sessionId: opened.sessionId, data: "secret\n" });
    await act("terminal.close", { sessionId: opened.sessionId });
    const messages = harness.activity.map((entry) => entry.message);
    expect(messages).toEqual(expect.arrayContaining([expect.stringContaining("opened"), expect.stringContaining("closed")]));
    expect(JSON.stringify(harness.activity)).not.toContain("secret");
  });

  it("answers can_open for the sidebar", async () => {
    const { harness } = await setup();
    expect(await harness.getData("terminal.can_open", { companyId: COMPANY, userId: "admin-1" })).toEqual({ allowed: true, role: "admin" });
    expect(await harness.getData("terminal.can_open", { companyId: COMPANY, userId: "member-1" })).toEqual({ allowed: false, role: "member" });
  });

  /**
   * Ruling P4-R36, extending P4-R13: opening a terminal is the most damaging thing a
   * just-removed or just-demoted admin could still do — it is full instance access — so it
   * re-reads the role from the host on every call, cache or no cache. The other actions act on
   * a session the caller already opened, and keep the 30-second cache.
   */
  it("re-asks the host for the role on every terminal.open, and takes the cache elsewhere", async () => {
    const harness = createTestHarness({ manifest, config: {} });
    harness.seed({ accessMembers: MEMBERS });
    const spawner = fakeSpawner();
    let listCalls = 0;
    const ctx = {
      ...harness.ctx,
      access: {
        ...harness.ctx.access,
        members: {
          ...harness.ctx.access.members,
          list: async (input: { companyId: string }) => {
            listCalls += 1;
            return await harness.ctx.access.members.list(input);
          },
        },
      },
    };
    let counter = 0;
    const plugin = createTerminalPlugin({
      createSpawner: () => spawner.spawn,
      loadKyoubeConfig: async () => KYOUBE_CONFIG,
      randomId: () => `id${++counter}`,
      sweepIntervalMs: 0,
    });
    await plugin.definition.setup(ctx);
    const act = <T,>(key: string, params: Record<string, unknown>) => harness.performAction<T>(key, params, { actor: ADMIN, companyId: COMPANY });

    const opened = await act<{ sessionId: string }>("terminal.open", {});
    expect(listCalls).toBe(1);
    // A second open well inside the 30-second cache window still asks the host.
    await act("terminal.open", {});
    expect(listCalls).toBe(2);
    // Acting on the session that is already open takes the cached answer.
    await act("terminal.input", { sessionId: opened.sessionId, data: "ls\n" });
    await act("terminal.attach", { sessionId: opened.sessionId, afterSeq: 0 });
    await act("terminal.list", {});
    expect(listCalls).toBe(2);

    // Demoted at the host, with the cache still warm: the next open is refused outright.
    harness.seed({ accessMembers: [{ ...MEMBERS[0]!, membershipRole: "member" }] });
    await expect(act("terminal.open", {})).rejects.toThrow("forbidden");
    expect(listCalls).toBe(3);
    // The fresh read rewrote the cache, so the session they already hold goes too.
    await expect(act("terminal.input", { sessionId: opened.sessionId, data: "ls\n" })).rejects.toThrow("forbidden");
    expect(listCalls).toBe(3);
  });
});

// Ruling P4-R24: health is only meaningful if it can fail. A worker whose pty layer cannot
// spawn a shell answers every `terminal.open` with a crash, so it must report `error`; a
// worker whose runtime config has gone unreadable still serves live sessions, so it is only
// `degraded`. (The SDK's `PluginHealthDiagnostics` calls the unhealthy state `"error"`.)
describe("kyoube.terminal health", () => {
  it("probes the shell with a one-shot spawn and reports ok, opening no session", async () => {
    const { plugin, spawner, act } = await setup();
    // The message names the shell that was probed: a company may override `shell`, and this
    // result says nothing about that one.
    expect(await plugin.definition.onHealth?.()).toEqual({ status: "ok", message: "kyoube.terminal ready; pty probe ok (/bin/bash)", details: { liveSessions: 0 } });
    expect(spawner.ptys).toHaveLength(1);
    expect(spawner.ptys[0]?.request).toEqual({ shell: "/bin/bash", cols: 1, rows: 1, args: ["-c", "exit 0"] });
    // The probe is not a session: it is never listed, and it consumed no per-user slot.
    expect(await act<{ sessions: unknown[] }>("terminal.list", {})).toEqual({ sessions: [] });
  });

  it("reports error when the pty layer cannot spawn the shell at all", async () => {
    const { plugin } = await setup({}, {
      createSpawner: () => () => {
        throw new Error("posix_spawnp failed: /bin/bash");
      },
    });
    const health = await plugin.definition.onHealth?.();
    expect(health).toMatchObject({ status: "error", details: { liveSessions: 0 } });
    expect(health?.message).toBe("kyoube.terminal pty probe failed for /bin/bash: posix_spawnp failed: /bin/bash");
  });

  it("reports error and kills the probe when the shell never exits", async () => {
    const spawner = fakeSpawner({ probeExit: null, exitOnKill: false });
    const { plugin } = await setup({}, { probeTimeoutMs: 5 }, spawner);
    const health = await plugin.definition.onHealth?.();
    expect(health).toMatchObject({ status: "error" });
    expect(health?.message).toContain("did not exit within 5 ms");
    expect(spawner.ptys[0]?.killed).toBe("SIGKILL");
  });

  it("reports error when the probe shell exits non-zero", async () => {
    const spawner = fakeSpawner({ probeExit: 127 });
    const { plugin } = await setup({}, {}, spawner);
    const health = await plugin.definition.onHealth?.();
    expect(health).toMatchObject({ status: "error" });
    expect(health?.message).toContain("exit code 127");
  });

  it("reports degraded with the reason when the kyoube config has become unreadable", async () => {
    let reads = 0;
    const { plugin } = await setup({}, {
      loadKyoubeConfig: async () => {
        if ((reads += 1) > 1) throw new Error("ENOENT: no such file or directory, open '/kyoubeai/kyoube/config.json'");
        return KYOUBE_CONFIG;
      },
    });
    const health = await plugin.definition.onHealth?.();
    expect(health).toMatchObject({ status: "degraded", details: { liveSessions: 0 } });
    expect(health?.message).toContain("ENOENT: no such file or directory");
  });

  it("counts live sessions and reports degraded before setup has run", async () => {
    const { plugin, act } = await setup();
    await act("terminal.open", {});
    expect(await plugin.definition.onHealth?.()).toMatchObject({ status: "ok", details: { liveSessions: 1 } });

    const unstarted = createTerminalPlugin({ createSpawner: () => fakeSpawner().spawn, loadKyoubeConfig: async () => KYOUBE_CONFIG });
    expect(await unstarted.definition.onHealth?.()).toEqual({ status: "degraded", message: "kyoube.terminal not ready" });
  });
});
