import { useCallback, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { actionErrorFrom, type ActionError } from "./error-code.js";
import { runOutputLoop, type OutputLoopState, type WaitResult } from "./output-loop.js";
import { createSessionStream, type TerminalStreamEvent } from "./session-stream.js";
import { ensureXtermStyles } from "./xterm-styles.js";

interface SessionSummary { id: string; ownerUserId: string; createdAt: string; lastActivityAt: string; alive: boolean; exitCode: number | null }
interface OpenResult { sessionId: string }
interface AttachResult { session: SessionSummary; events: TerminalStreamEvent[]; truncated: boolean }

const INPUT_FLUSH_MS = 16;
/**
 * How long one `terminal.wait` parks for output. Well inside the worker's own cap and the host's
 * 30 s action timeout; an idle terminal costs one request per this interval.
 */
const WAIT_TIMEOUT_MS = 10_000;
/** Only `terminal.open` can be forbidden for one reason alone, so only it adds this wording. */
const OPEN_FORBIDDEN_HINT = "Your company role cannot open a terminal.";

const HELP: Array<[string, string]> = [
  ["claude login", "Claude Code OAuth login; credentials are stored under /kyoubeai/.claude"],
  ["pi", "pi coding agent; run `pi` and use /login or set provider keys in ~/.pi"],
  ["hermes setup", "Hermes Agent wizard (provider, model); data under /kyoubeai/.hermes"],
  ["kyoube doctor", "KyoubeAI health checks (config, databases, plugins, harness CLIs)"],
];

function outputStatusLabel(state: OutputLoopState): string {
  switch (state.kind) {
    case "connecting":
      return "Connecting…";
    case "live":
      return "Live";
    case "retrying":
      return `Output error: ${state.error} (retrying)`;
    case "failed":
      return `Output error: ${state.error}`;
    case "ended":
      return "";
  }
}

export function TerminalPage({ context }: PluginPageProps) {
  const companyId = context.companyId ?? "";
  const open = usePluginAction("terminal.open");
  const attach = usePluginAction("terminal.attach");
  const wait = usePluginAction("terminal.wait");
  const input = usePluginAction("terminal.input");
  const resize = usePluginAction("terminal.resize");
  const close = usePluginAction("terminal.close");
  const list = usePluginAction("terminal.list");
  const kill = usePluginAction("terminal.kill");

  // `input`/`resize`/`wait` (like every `usePluginAction` result) are not guaranteed
  // referentially stable across renders, since the SDK delegates to the host bridge. The
  // keystroke/resize effect and the output loop below must not depend on them directly — see
  // those effects for why — so they read them through this ref, kept current on every render.
  const actionsRef = useRef({ input, resize, wait });
  actionsRef.current = { input, resize, wait };

  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const pendingInput = useRef<string[]>([]);
  const flushTimer = useRef<number | null>(null);

  const [session, setSession] = useState<OpenResult | null>(null);
  const [status, setStatus] = useState<string>("No session");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState<ActionError | null>(null);
  const [outputState, setOutputState] = useState<OutputLoopState>({ kind: "connecting" });

  // Everything that decides *whether* an event reaches the terminal — the per-session
  // de-duplication by seq, and the generation that retires a switched-away session — lives in
  // `session-stream.ts`; the polling that fetches events lives in `output-loop.ts`. Both are
  // tested without a DOM; this page only renders what they hand back.
  const streamRef = useRef(
    createSessionStream({
      apply: (event) => {
        if (event.type === "output") termRef.current?.write(event.data);
        else {
          termRef.current?.write(`\r\n[process exited with code ${event.exitCode}]\r\n`);
          setStatus(`Exited (${event.exitCode})`);
        }
      },
      notice: (text) => termRef.current?.write(text),
    }),
  );

  const refreshList = useCallback(async () => {
    try {
      const result = (await list({})) as { sessions: SessionSummary[] };
      setSessions(result.sessions);
    } catch (err) {
      setError(actionErrorFrom(err));
    }
  }, [list]);
  // Read by the output loop's effect, which must not depend on `refreshList` (it changes with `list`).
  const refreshListRef = useRef(refreshList);
  refreshListRef.current = refreshList;

  // Mount xterm once. The host div below is always rendered (even before `companyId` is
  // available), so this effect's `[]` deps are sufficient: it runs once after the first
  // commit and `hostRef.current` is already attached by then.
  useEffect(() => {
    ensureXtermStyles();
    if (!hostRef.current || termRef.current) return;
    const term = new Terminal({ cursorBlink: true, fontSize: 13, scrollback: 5000, theme: { background: "#0b0f14" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    return () => { term.dispose(); termRef.current = null; };
  }, []);

  // Wire keystrokes (batched) and resizes to the current session. Depends on `[session]` only:
  // `resize` (and `input`, via the flush below) come from `usePluginAction` and are not
  // guaranteed referentially stable, so depending on them directly would tear down and
  // recreate the `ResizeObserver`/`onData` subscription — re-firing the observer's initial
  // `fit()` + resize action — on renders where only they changed identity, not `session`.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !session) return;
    const sessionId = session.sessionId;

    function flush() {
      flushTimer.current = null;
      const data = pendingInput.current.join("");
      pendingInput.current = [];
      if (data.length === 0) return;
      actionsRef.current.input({ sessionId, data }).catch((err) => setError(actionErrorFrom(err)));
    }

    const dataSub = term.onData((data) => {
      pendingInput.current.push(data);
      if (flushTimer.current === null) flushTimer.current = window.setTimeout(flush, INPUT_FLUSH_MS);
    });
    const observer = new ResizeObserver(() => {
      fitRef.current?.fit();
      actionsRef.current.resize({ sessionId, cols: term.cols, rows: term.rows }).catch(() => {});
    });
    if (hostRef.current) observer.observe(hostRef.current);

    return () => {
      dataSub.dispose();
      observer.disconnect();
      // Buffered keystrokes must never drain to a previous session or fire after unmount.
      if (flushTimer.current !== null) {
        window.clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
      pendingInput.current = [];
    };
  }, [session]);

  // Pull the session's output with back-to-back `terminal.wait` long-polls, from the seq the
  // terminal has already seen. One loop per session: the cleanup stops it before the next one
  // starts, and a poll still in flight when that happens is discarded, never written. Depends on
  // `[session]` only, for the same reason as the effect above; `wait` is read through the ref.
  useEffect(() => {
    if (!session) return;
    const sessionId = session.sessionId;
    const loop = runOutputLoop({
      stream: streamRef.current,
      generation: streamRef.current.generation,
      wait: async (afterSeq) => (await actionsRef.current.wait({ sessionId, afterSeq, timeoutMs: WAIT_TIMEOUT_MS })) as WaitResult,
      onState: (state) => {
        setOutputState(state);
        // The worker no longer knows this session — it restarted (a plugin upgrade), or the sweep
        // pruned it — so "Connected" would be a lie, and the session's row in the list is stale.
        if (state.kind === "failed" && state.code === "not_found") {
          setStatus("Session lost");
          refreshListRef.current().catch(() => {});
        }
      },
    });
    return () => loop.stop();
  }, [session]);

  /** Starts a fresh per-session identity so nothing from the previous session leaks into this one. */
  const beginSession = useCallback(() => {
    const generation = streamRef.current.beginSession();
    termRef.current?.reset();
    return generation;
  }, []);

  const replay = useCallback(
    (sessionId: string, generation: number) =>
      streamRef.current.replay(generation, async (afterSeq) => (await attach({ sessionId, afterSeq })) as AttachResult),
    [attach],
  );

  const startSession = useCallback(async () => {
    setError(null);
    const term = termRef.current;
    fitRef.current?.fit();
    try {
      const opened = (await open({ cols: term?.cols ?? 100, rows: term?.rows ?? 30 })) as OpenResult;
      beginSession();
      setSession({ sessionId: opened.sessionId });
      setStatus("Connected");
      term?.focus();
      await refreshList();
    } catch (err) {
      setError(actionErrorFrom(err, OPEN_FORBIDDEN_HINT));
    }
  }, [open, refreshList, beginSession]);

  const resumeSession = useCallback(async (sessionId: string) => {
    setError(null);
    // Retire the previous session *before* awaiting the replay (ruling P1-R20 a). Dropping the
    // session stops its output loop, and `beginSession` bumps the generation every event is
    // tagged with, so a poll already in flight for that loop can no longer enter the new tracker —
    // where its sequence numbers (which restart at 1 per session) would suppress real output.
    setSession(null);
    const generation = beginSession();
    try {
      const result = await replay(sessionId, generation);
      // A second attach clicked while this one was in flight has already retired this
      // generation (the replay applied nothing); it must not now install this session either.
      if (streamRef.current.generation !== generation) return;
      // The scrollback is on screen; the loop then continues from the seq the replay reached.
      setSession({ sessionId });
      setStatus(result.session.alive ? "Connected (resumed)" : `Exited (${result.session.exitCode})`);
      termRef.current?.focus();
    } catch (err) {
      const failure = actionErrorFrom(err);
      setError(failure);
      setStatus("No session");
      // The list is a snapshot: the sweep prunes a session some minutes after its shell exits,
      // so the row that was clicked can already be gone (ruling P1-R20 e). Drop it from the list
      // rather than leaving a row that keeps failing.
      if (failure.code === "not_found") await refreshList();
    }
  }, [replay, beginSession, refreshList]);

  const endSession = useCallback(async () => {
    if (!session) return;
    try {
      await close({ sessionId: session.sessionId });
    } catch (err) {
      setError(actionErrorFrom(err));
    }
    setSession(null);
    setStatus("No session");
    await refreshList();
  }, [close, session, refreshList]);

  // Action functions from usePluginAction are not guaranteed referentially stable; never list them as effect deps.
  useEffect(() => { refreshList().catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const outputLabel = outputStatusLabel(outputState);
  const outputFailing = outputState.kind === "retrying" || outputState.kind === "failed";

  // The host div below is always rendered — even while `companyId` is still hydrating — so the
  // xterm mount effect (which runs once, on first commit) always finds it. Only the toolbar and
  // the company-scoped sections are gated on `companyId`.
  return (
    <div className="flex h-full flex-col gap-3 p-4" data-kyoube-page="terminal">
      {companyId ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <strong>Terminal</strong>
          <span className="text-foreground/60">{status}</span>
          {session && outputLabel && (
            <span className={outputFailing ? "text-red-600" : "text-foreground/60"}>{outputLabel}</span>
          )}
          {error && <span className="text-red-600">{error.text}</span>}
          <span className="flex-1" />
          <button type="button" className="rounded border px-2 py-1" onClick={() => { startSession().catch(() => {}); }}>New session</button>
          <button type="button" className="rounded border px-2 py-1" disabled={!session} onClick={() => { endSession().catch(() => {}); }}>Close session</button>
        </div>
      ) : (
        <div className="text-sm">Select a company to use the terminal.</div>
      )}
      <div ref={hostRef} className="kyoube-terminal-host" />
      {companyId && (
        <>
          <details className="text-xs text-foreground/70">
            <summary>Sessions in this company</summary>
            <ul className="mt-1 space-y-1">
              {sessions.map((item) => (
                <li key={item.id} className="flex items-center gap-2">
                  <code>{item.id.slice(0, 12)}</code>
                  <span>{item.alive ? "live" : `exited ${item.exitCode ?? ""}`}</span>
                  <span>owner {item.ownerUserId.slice(0, 8)}</span>
                  <button type="button" className="underline" onClick={() => { resumeSession(item.id).catch(() => {}); }}>attach</button>
                  <button type="button" className="underline" onClick={() => { kill({ sessionId: item.id }).then(refreshList).catch((err) => setError(actionErrorFrom(err))); }}>kill</button>
                </li>
              ))}
              {sessions.length === 0 && <li>None</li>}
            </ul>
          </details>
          <details className="text-xs text-foreground/70">
            <summary>Authenticate the agent harnesses</summary>
            <ul className="mt-1 space-y-1">
              {HELP.map(([command, text]) => (
                <li key={command}><code>{command}</code> — {text}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
