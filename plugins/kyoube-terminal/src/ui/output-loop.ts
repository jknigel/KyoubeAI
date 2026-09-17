import { bridgeErrorMessage, errorCodeFrom } from "./error-code.js";
import type { ReplayResult, SessionStream } from "./session-stream.js";

/**
 * What the page shows next to the session status. `retrying` carries the failure it is
 * backing off from; `failed` is final (the session is gone, or was never this user's) and
 * names the worker's code; `ended` means the shell exited and the loop has nothing left to fetch.
 */
export type OutputLoopState =
  | { kind: "connecting" }
  | { kind: "live" }
  | { kind: "retrying"; error: string; attempt: number }
  | { kind: "failed"; error: string; code: string }
  | { kind: "ended" };

/** The part of `terminal.wait`'s answer the loop acts on. */
export interface WaitResult extends ReplayResult {
  session: { alive: boolean; exitCode: number | null };
}

export interface OutputLoopOptions {
  stream: SessionStream;
  /** The session generation this loop serves; the loop ends as soon as the stream moves on. */
  generation: number;
  /** One long-poll from `afterSeq`; answers with whatever arrived, possibly nothing. */
  wait: (afterSeq: number) => Promise<WaitResult>;
  onState: (state: OutputLoopState) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface OutputLoop {
  /** Ends the loop; an answer still in flight is discarded, not written. */
  stop(): void;
  /** Settles once the loop has stopped issuing polls. */
  done: Promise<void>;
}

export const RETRY_BASE_MS = 250;
export const RETRY_MAX_MS = 5_000;
/** Failures a retry cannot fix: the session is gone, was never this user's, or the call is malformed. */
const PERMANENT_CODES = new Set(["not_found", "forbidden", "invalid"]);
/** The host's bridge code for "the worker's handler answered with an error" (SDK `PluginBridgeErrorCode`). */
const HANDLER_ANSWERED = "WORKER_ERROR";

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function transportCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * The worker names a permanent failure in its message (`<code>: …`), but the host pads a crashed
 * or unreachable worker's message with that worker's stderr, which may contain any of these words.
 * So a code token only counts when the host's own transport code says the worker's handler was
 * the one talking, or when there is no transport code at all (a plain `Error`).
 */
function permanentCodeOf(error: unknown): string | null {
  const code = errorCodeFrom(error);
  if (!PERMANENT_CODES.has(code)) return null;
  const transport = transportCodeOf(error);
  return transport === undefined || transport === HANDLER_ANSWERED ? code : null;
}

/**
 * Pulls a session's output with back-to-back `terminal.wait` long-polls, each starting from the
 * highest sequence number the terminal has seen. One poll is in flight at a time, so the order
 * events are applied in is the order the worker numbered them; the `SessionStream` still
 * de-duplicates by seq and retires a generation the page has moved away from.
 *
 * Upstream never wired its plugin SSE bridge (`/bridge/stream` answers 501, and the host drops a
 * worker's asynchronous emits), so this loop is how output reaches the tab at all.
 */
export function runOutputLoop(options: OutputLoopOptions): OutputLoop {
  const { stream, generation, wait, onState } = options;
  const sleep = options.sleep ?? defaultSleep;
  let stopped = false;
  let reported: OutputLoopState["kind"] | null = null;
  const active = () => !stopped && stream.generation === generation;
  const report = (state: OutputLoopState) => {
    if (!active()) return;
    if (state.kind === "live" && reported === "live") return;
    reported = state.kind;
    onState(state);
  };
  // A stopped loop turns whatever its last poll brings back into an empty answer, so the
  // stream applies nothing to a terminal the page has already moved on from.
  const fetch = async (afterSeq: number): Promise<WaitResult> => {
    const result = await wait(afterSeq);
    return active() ? result : { ...result, events: [], truncated: false };
  };

  report({ kind: "connecting" });
  const done = (async () => {
    let attempt = 0;
    while (active()) {
      try {
        const result = await stream.replay(generation, fetch);
        if (!active()) return;
        attempt = 0;
        if (!result.session.alive) {
          report({ kind: "ended" });
          return;
        }
        report({ kind: "live" });
      } catch (error) {
        if (!active()) return;
        const message = bridgeErrorMessage(error);
        const permanent = permanentCodeOf(error);
        if (permanent) {
          report({ kind: "failed", error: message, code: permanent });
          return;
        }
        attempt += 1;
        report({ kind: "retrying", error: message, attempt });
        await sleep(Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1)));
      }
    }
  })();

  return {
    stop() {
      stopped = true;
    },
    done,
  };
}
