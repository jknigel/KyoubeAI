import { definePlugin, type PaperclipPlugin, type PluginContext } from "@paperclipai/plugin-sdk";
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk/protocol";
import { RoleResolver } from "./auth.js";
import { TerminalError } from "./errors.js";
import type { KyoubeRuntimeConfig } from "./kyoube-config.js";
import { PLUGIN_ID } from "./manifest.js";
import { SessionManager, type PtyLike, type PtySpawner } from "./sessions.js";
import { DEFAULT_SETTINGS, resolveSettings, type TerminalSettings } from "./settings.js";
import { buildShellEnv } from "./spawn-env.js";

export interface TerminalPluginDeps {
  createSpawner: (opts: { cwd: string; env: Record<string, string> }) => PtySpawner;
  loadKyoubeConfig: () => Promise<KyoubeRuntimeConfig>;
  now?: () => number;
  randomId?: () => string;
  /** 0 disables the periodic idle sweep (tests). */
  sweepIntervalMs?: number;
  /** How long `onHealth`'s shell probe may take before it counts as failed. */
  probeTimeoutMs?: number;
}

type Params = Record<string, unknown>;

/** The health probe's shell arguments: run nothing and exit, so no profile is sourced. */
const PROBE_ARGS = ["-c", "exit 0"];
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Ruling P4-R24: a worker whose pty layer cannot spawn a shell answers every `terminal.open`
 * with a crash, so health has to be able to say so. One spawn of the configured shell with
 * `-c exit 0` costs a fork and no profile, and covers what actually breaks — a missing shell, a
 * broken `@lydell/node-pty` native binding, or a container out of pty slots. Bounded by a short
 * timeout because a wedged pty layer typically hangs rather than throwing, and the probe pty is
 * killed on that path so a stuck probe cannot accumulate processes across health calls.
 */
async function probeShell(spawn: PtySpawner, shell: string, timeoutMs: number): Promise<{ ok: true } | { ok: false; reason: string }> {
  return await new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (result: { ok: true } | { ok: false; reason: string }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    let pty: PtyLike;
    try {
      pty = spawn({ shell, cols: 1, rows: 1, args: PROBE_ARGS });
    } catch (error) {
      finish({ ok: false, reason: messageOf(error) });
      return;
    }
    timer = setTimeout(() => {
      // The probe is the only thing holding this pty; a shell that never exits is a failure and
      // must not outlive the health call.
      try {
        pty.kill("SIGKILL");
      } catch {
        // Already gone; the timeout is the answer either way.
      }
      finish({ ok: false, reason: `did not exit within ${timeoutMs} ms` });
    }, timeoutMs);
    timer.unref?.(); // a health probe must never hold the worker process open
    pty.onExit(({ exitCode }) => {
      finish(exitCode === 0 ? { ok: true } : { ok: false, reason: `exited with exit code ${exitCode}` });
    });
  });
}

/** Hard cap on one `terminal.input` payload; a keystroke stream never needs more, and a paste this
 *  large would otherwise be written straight into the pty (and buffered by the host) unbounded. */
export const MAX_INPUT_BYTES = 1024 * 1024;

function str(params: Params, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) throw new TerminalError("invalid", `${key} is required`);
  return value;
}

function clampInt(value: unknown, key: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new TerminalError("invalid", `${key} must be a number`);
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function int(params: Params, key: string, fallback: number, min: number, max: number): number {
  return clampInt(params[key], key, fallback, min, max);
}

/** How long one `terminal.wait` parks for output when the caller does not say. */
export const DEFAULT_WAIT_MS = 10_000;
/**
 * The longest a `terminal.wait` may park. Upstream fails a plugin action RPC after 30 s
 * (`DEFAULT_RPC_TIMEOUT_MS`, server/src/services/plugin-worker-manager.ts), so a poll must
 * always answer well inside that, host latency included.
 */
export const MAX_WAIT_MS = 20_000;

export function resolveWaitTimeoutMs(value: unknown): number {
  return clampInt(value, "timeoutMs", DEFAULT_WAIT_MS, 0, MAX_WAIT_MS);
}

export function createTerminalPlugin(deps: TerminalPluginDeps): PaperclipPlugin {
  let manager: SessionManager | null = null;
  let sweeper: NodeJS.Timeout | null = null;
  /** Kept for `onHealth`'s probe; null until `setup` has run. */
  let spawn: PtySpawner | null = null;

  return definePlugin({
    async setup(ctx: PluginContext) {
      const kyoube = await deps.loadKyoubeConfig();
      const roles = new RoleResolver(ctx.access.members, { now: deps.now });
      const spawner = deps.createSpawner({
        cwd: kyoube.home,
        env: buildShellEnv({ home: kyoube.home, hermesHome: kyoube.hermesHome, shell: "/bin/bash", path: process.env.PATH, source: process.env }),
      });
      spawn = spawner;
      const sessions = new SessionManager({ spawn: spawner, now: deps.now, randomId: deps.randomId });
      manager = sessions;

      const sweepMs = deps.sweepIntervalMs ?? 30_000;
      if (sweepMs > 0) {
        sweeper = setInterval(() => {
          const swept = sessions.sweepIdle();
          for (const id of swept.closed) ctx.logger.info("terminal session closed after idle timeout", { sessionId: id });
          for (const id of swept.pruned) ctx.logger.info("terminal session pruned after the dead-session retention window", { sessionId: id });
        }, sweepMs);
        sweeper.unref();
      }

      /**
       * `opts.fresh` (ruling P4-R36) reads the caller's role straight from the host instead of
       * from the 30-second cache. Only `terminal.open` asks for it: it is the one action that
       * hands out full instance access, so a demotion or removal may not be outrun by a warm
       * cache. The rest act on a session this user already has open.
       */
      async function authorize(context: PluginPerformActionContext, params: Params, opts: { fresh?: boolean } = {}): Promise<{ companyId: string; userId: string; settings: TerminalSettings; role: string }> {
        const actor = context.actor;
        // The host's company scope wins. A caller-supplied `companyId` is only a fallback for a
        // bridge call the host did not scope; when the host did scope the call, a different
        // `params.companyId` is a spoofing attempt, not a fallback, and is rejected outright.
        const claimed = typeof params.companyId === "string" && params.companyId.length > 0 ? params.companyId : null;
        if (context.companyId && claimed && claimed !== context.companyId) {
          throw new TerminalError("invalid", "companyId does not match the authorized company scope");
        }
        const companyId = context.companyId ?? claimed;
        if (!companyId) throw new TerminalError("invalid", "companyId is required");
        const settings = resolveSettings(await ctx.config.get(companyId));
        if (actor.type !== "user" || !actor.userId) {
          await ctx.activity.log({ companyId, message: "Terminal access denied: not a signed-in user", entityType: "terminal", metadata: { actorType: actor.type } });
          throw new TerminalError("forbidden", "the terminal requires a signed-in user");
        }
        try {
          const role = await roles.assertAllowed(companyId, actor.userId, settings.allowedRoles, { fresh: opts.fresh });
          return { companyId, userId: actor.userId, settings, role };
        } catch (error) {
          // Only audit an actual access denial. A failure of the role lookup itself
          // (e.g. the members API erroring) is an infrastructure fault, not a denial,
          // so it must propagate unchanged with no "denied" entry in the audit log.
          if (error instanceof TerminalError && error.code === "forbidden") {
            await ctx.activity.log({ companyId, message: `Terminal access denied for user ${actor.userId}`, entityType: "terminal", metadata: { userId: actor.userId, allowedRoles: settings.allowedRoles } });
          }
          throw error;
        }
      }

      ctx.data.register("terminal.can_open", async (params) => {
        const companyId = typeof params.companyId === "string" ? params.companyId : null;
        const userId = typeof params.userId === "string" ? params.userId : null;
        if (!companyId || !userId) return { allowed: false, role: null };
        const settings = resolveSettings(await ctx.config.get(companyId));
        const role = await roles.resolveRole(companyId, userId);
        return { allowed: role !== null && settings.allowedRoles.includes(role), role };
      });

      ctx.actions.register("terminal.open", async (params, context) => {
        const { companyId, userId, settings } = await authorize(context, params, { fresh: true });
        const cols = int(params, "cols", 80, 20, 500);
        const rows = int(params, "rows", 24, 5, 200);
        const opened = sessions.open({
          ownerUserId: userId,
          companyId,
          cols,
          rows,
          shell: settings.shell,
          idleTimeoutMs: settings.idleTimeoutMinutes * 60_000,
          maxSessionsPerUser: settings.maxSessionsPerUser,
          scrollbackBytes: settings.scrollbackKb * 1024,
        });
        await ctx.activity.log({ companyId, message: `Terminal session opened by user ${userId}`, entityType: "terminal_session", entityId: opened.session.id, metadata: { userId, cols, rows } });
        return { sessionId: opened.session.id, session: opened.session };
      });

      ctx.actions.register("terminal.attach", async (params, context) => {
        const { companyId, userId } = await authorize(context, params);
        const result = sessions.attach(str(params, "sessionId"), userId, companyId, int(params, "afterSeq", 0, 0, Number.MAX_SAFE_INTEGER));
        return result;
      });

      ctx.actions.register("terminal.wait", async (params, context) => {
        const { companyId, userId } = await authorize(context, params);
        return await sessions.wait(
          str(params, "sessionId"),
          userId,
          companyId,
          int(params, "afterSeq", 0, 0, Number.MAX_SAFE_INTEGER),
          resolveWaitTimeoutMs(params.timeoutMs),
        );
      });

      ctx.actions.register("terminal.input", async (params, context) => {
        const { companyId, userId } = await authorize(context, params);
        const data = str(params, "data");
        if (Buffer.byteLength(data, "utf8") > MAX_INPUT_BYTES) {
          throw new TerminalError("invalid", `data must be at most ${MAX_INPUT_BYTES} bytes`);
        }
        sessions.input(str(params, "sessionId"), userId, companyId, data);
        return { ok: true };
      });

      ctx.actions.register("terminal.resize", async (params, context) => {
        const { companyId, userId } = await authorize(context, params);
        sessions.resize(str(params, "sessionId"), userId, companyId, int(params, "cols", 80, 20, 500), int(params, "rows", 24, 5, 200));
        return { ok: true };
      });

      ctx.actions.register("terminal.close", async (params, context) => {
        const { companyId, userId } = await authorize(context, params);
        const sessionId = str(params, "sessionId");
        sessions.close(sessionId, userId, companyId);
        await ctx.activity.log({ companyId, message: `Terminal session closed by user ${userId}`, entityType: "terminal_session", entityId: sessionId, metadata: { userId } });
        return { ok: true };
      });

      ctx.actions.register("terminal.list", async (params, context) => {
        const { companyId } = await authorize(context, params);
        return { sessions: sessions.list(companyId) };
      });

      ctx.actions.register("terminal.kill", async (params, context) => {
        const { companyId, userId } = await authorize(context, params);
        const sessionId = str(params, "sessionId");
        const target = sessions.list(companyId).find((session) => session.id === sessionId);
        if (!target) throw new TerminalError("not_found", `no session ${sessionId} in this company`);
        sessions.kill(sessionId, companyId);
        await ctx.activity.log({ companyId, message: `Terminal session killed by user ${userId}`, entityType: "terminal_session", entityId: sessionId, metadata: { userId, ownerUserId: target.ownerUserId } });
        return { ok: true };
      });

      ctx.logger.info(`${PLUGIN_ID} worker ready`, { home: kyoube.home });
    },

    async onHealth() {
      // A worker whose `setup` has not finished (or has shut down) has no spawner and no
      // sessions, so it must not report `ok`.
      const sessions = manager;
      const spawner = spawn;
      if (!sessions || !spawner) return { status: "degraded", message: `${PLUGIN_ID} not ready` };
      const details = { liveSessions: sessions.count() };
      // The health call has no company scope, so the probe uses the default shell — the one
      // `setup` built the environment for and the one a company inherits unless it overrides it.
      // Which shell was probed is named in every message, so an operator whose company overrides
      // `shell` can see that this result says nothing about that one.
      const shell = DEFAULT_SETTINGS.shell;
      const probe = await probeShell(spawner, shell, deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
      if (!probe.ok) return { status: "error", message: `${PLUGIN_ID} pty probe failed for ${shell}: ${probe.reason}`, details };
      try {
        // Re-read rather than trust the copy `setup` took: the file is what a restarted session
        // would be configured from, and a worker that can still serve live sessions with an
        // unreadable config is degraded, not dead.
        await deps.loadKyoubeConfig();
      } catch (error) {
        return { status: "degraded", message: `${PLUGIN_ID} config is unreadable: ${messageOf(error)}`, details };
      }
      return { status: "ok", message: `${PLUGIN_ID} ready; pty probe ok (${shell})`, details };
    },

    async onShutdown() {
      if (sweeper) clearInterval(sweeper);
      manager?.shutdown();
      spawn = null;
    },
  });
}
