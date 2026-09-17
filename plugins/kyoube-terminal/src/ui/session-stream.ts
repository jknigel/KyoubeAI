import { createOutputTracker } from "./output-tracker.js";

export type TerminalStreamEvent =
  | { seq: number; type: "output"; data: string }
  | { seq: number; type: "exit"; exitCode: number };

/** The part of a `terminal.attach` / `terminal.wait` answer the ordering depends on. */
export interface ReplayResult {
  events: TerminalStreamEvent[];
  truncated: boolean;
}

export interface SessionStreamSink {
  /** Renders one event the tracker accepted (output to the terminal, exit to the status line). */
  apply(event: TerminalStreamEvent): void;
  /** Writes a marker line the user has to see; already wrapped in CRLFs. */
  notice(text: string): void;
}

/** The worker had already trimmed its scrollback when this session was first attached to. */
export const SCROLLBACK_TRUNCATED_NOTICE = "[… earlier output truncated …]\r\n";
/**
 * The worker trimmed events past the last seq this terminal had applied before the page fetched
 * them: with polling, the scrollback cap is also the window between two polls, and a chatty
 * command on a slow link can outrun it. The loss is marked where it happened.
 */
export const OUTPUT_GAP_NOTICE = "\r\n[… output lost: the terminal fell behind the session's scrollback …]\r\n";

/**
 * Orders everything that can write to the terminal: the resume replay (`terminal.attach`) and the
 * output loop's polls (`terminal.wait`), which both go through `replay()`. Two rules:
 *
 * - **One session at a time (P1-R20 a).** Sequence numbers restart at 1 per session, so an answer
 *   from the previous session would either be written into the new terminal or (worse) advance
 *   the new session's high-water mark past output that has not arrived yet. `beginSession()`
 *   retires the old generation; a replay started for it still answers its caller, but applies
 *   nothing once the switch has happened.
 * - **De-duplicated by seq.** A resume replay and the first poll after it may overlap on the
 *   seq they share; the tracker writes each seq once and the next fetch starts past it.
 *
 * The page keeps the React and xterm halves: this module never touches either, which is what
 * makes the ordering testable without a DOM.
 */
export interface SessionStream {
  /** The current session's generation; the output loop captures it when it starts. */
  readonly generation: number;
  /** High-water mark of the current session — the `afterSeq` the next fetch starts from. */
  readonly lastSeq: number;
  /** Retires the current session and starts a fresh identity; returns the new generation. */
  beginSession(): number;
  /**
   * Runs one fetch from the current high-water mark and applies what it returns, in order.
   * `fetch` is called with the seq to resume from.
   */
  replay<R extends ReplayResult>(generation: number, fetch: (afterSeq: number) => Promise<R>): Promise<R>;
}

export function createSessionStream(sink: SessionStreamSink): SessionStream {
  let generation = 0;
  let tracker = createOutputTracker();

  return {
    get generation(): number {
      return generation;
    },
    get lastSeq(): number {
      return tracker.lastSeq;
    },

    beginSession(): number {
      generation += 1;
      tracker = createOutputTracker();
      return generation;
    },

    async replay<R extends ReplayResult>(forGeneration: number, fetch: (afterSeq: number) => Promise<R>): Promise<R> {
      // A replay for a session that has already been retired must not read the live session's
      // mark, and must not apply anything: its events belong to a terminal that has since been
      // reset. It still answers the caller, which awaits a result.
      const afterSeq = forGeneration === generation ? tracker.lastSeq : 0;
      const result = await fetch(afterSeq);
      if (forGeneration !== generation) return result;
      // `truncated` means the worker trimmed events past `afterSeq`. From the very start that is
      // the scrollback's age; from anywhere later it is output this terminal never got to apply,
      // since `afterSeq` is the highest seq it has applied. Either way the marker goes ahead of
      // the events that survived, where the missing ones belong.
      if (result.truncated) sink.notice(afterSeq === 0 ? SCROLLBACK_TRUNCATED_NOTICE : OUTPUT_GAP_NOTICE);
      for (const event of result.events) {
        if (tracker.accept(event)) sink.apply(event);
      }
      return result;
    },
  };
}
