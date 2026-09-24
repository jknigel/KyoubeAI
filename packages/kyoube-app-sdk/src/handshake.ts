/**
 * The install handshake's retry schedule (ruling P4-R29).
 *
 * The host announces an app's context *only* in answer to a hello carrying the
 * mount's nonce — nothing announces it on a frame load, because a load cannot
 * say whose document just arrived. That makes the hello the single point of
 * failure for the handshake: it is posted while the app document is still
 * parsing, which can be before the runner's `message` listener is attached, and
 * a message posted to a window with no listener is simply gone.
 *
 * So the SDK repeats it. `HELLO_ATTEMPTS` tries at `HELLO_RETRY_MS` apart is
 * five seconds of patience — far longer than a listener takes to attach, and
 * bounded so a frame whose host never answers (a runner that stopped, a
 * document the app navigated itself to) falls silent instead of posting forever.
 * Giving up is silent: `kyoube.ready()` stays pending, which is what an app that
 * never got a context should see.
 *
 * This lives apart from `sdk.ts` because that file is an IIFE that installs
 * itself on import — it cannot be exercised without a DOM. The scheduling is
 * the part worth testing, so it takes its timers as an argument and is tested
 * against fake ones.
 */
export const HELLO_RETRY_MS = 250;
export const HELLO_ATTEMPTS = 20;

/** The subset of the timer API this needs, so a test can hand it a fake clock. */
export interface HelloTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * Posts `send()` now, and again every `HELLO_RETRY_MS` until the returned
 * function is called (the host answered) or `HELLO_ATTEMPTS` are used up.
 * The returned function is idempotent and safe to call after the attempts have
 * run out.
 */
export function startHello(send: () => void, timers: HelloTimers): () => void {
  let attempts = 0;
  let handle: unknown = null;
  let answered = false;
  const tick = (): void => {
    if (answered) return;
    attempts += 1;
    send();
    handle = attempts < HELLO_ATTEMPTS ? timers.setTimeout(tick, HELLO_RETRY_MS) : null;
  };
  tick();
  return () => {
    if (answered) return;
    answered = true;
    if (handle !== null) timers.clearTimeout(handle);
    handle = null;
  };
}
