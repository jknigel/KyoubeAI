import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SETUP_TOKEN_RE, extractSetupToken, isSignInAttemptDir, writeCredentials } from "../claude-token.js";
import { systemProbe } from "../harnesses.js";

/** Exit code for a sign-in the user cancelled (128 + SIGINT, as a shell reports Ctrl+C). */
export const CANCELLED = 130;

export interface ConnectDeps {
  claudeOnPath(env: NodeJS.ProcessEnv): Promise<boolean>;
  /** Runs `claude setup-token` attached to the terminal with CLAUDE_CONFIG_DIR=dir, and returns what it printed. */
  runSetupToken(dir: string, env: NodeJS.ProcessEnv): Promise<{ code: number; transcript: string }>;
  /** Reads a pasted token without echoing it. */
  promptToken(): Promise<string>;
  now(): number;
  log(line: string): void;
}

/** The parts of Node that runCaptured uses, so its signal handling can be tested without real signals. */
export interface CaptureHost {
  spawn(command: string, args: string[], env: NodeJS.ProcessEnv): {
    on(event: "error", listener: () => void): unknown;
    on(event: "close", listener: (code: number | null) => void): unknown;
  };
  on(signal: NodeJS.Signals, listener: () => void): void;
  off(signal: NodeJS.Signals, listener: () => void): void;
  exit(code: number): void;
}

const nodeHost: CaptureHost = {
  spawn: (command, args, env) => spawn(command, args, { env, stdio: "inherit" }),
  on: (signal, listener) => { process.on(signal, listener); },
  off: (signal, listener) => { process.off(signal, listener); },
  exit: (code) => { process.exit(code); },
};

/**
 * Runs `claude setup-token` under `script` (util-linux), which gives claude a real terminal and keeps a copy of
 * the screen in CAPTURE, and returns what it printed. The copy can hold the token, so it is created readable by
 * its owner only (script keeps an existing file's mode) and removed however the run ends. Ctrl+C reaches claude
 * while this process waits it out, as a shell does for the program it runs, and then reports CANCELLED; a
 * hang-up or kill (the Terminal session closing) removes the copy before exiting.
 */
export async function runCaptured(
  capture: string,
  env: NodeJS.ProcessEnv,
  host: CaptureHost = nodeHost,
): Promise<{ code: number; transcript: string }> {
  await writeFile(capture, "", { mode: 0o600 });
  return new Promise((resolve) => {
    let interrupted = false;
    let finished = false;
    const onInterrupt = () => { interrupted = true; };
    const onHangUp = () => { rmSync(capture, { force: true }); host.exit(129); };
    const onTerminate = () => { rmSync(capture, { force: true }); host.exit(143); };
    const handlers: [NodeJS.Signals, () => void][] = [
      ["SIGINT", onInterrupt], ["SIGQUIT", onInterrupt], ["SIGHUP", onHangUp], ["SIGTERM", onTerminate],
    ];
    for (const [signal, handler] of handlers) host.on(signal, handler);
    const done = async (code: number) => {
      if (finished) return;
      finished = true;
      const transcript = await readFile(capture, "utf8").catch(() => "");
      await rm(capture, { force: true });
      for (const [signal, handler] of handlers) host.off(signal, handler);
      // A token printed before the interrupt still counts; otherwise the user stopped the sign-in.
      resolve({ code: interrupted && extractSetupToken(transcript) === null ? CANCELLED : code, transcript });
    };
    const child = host.spawn("script", ["-q", "-f", "-e", "-c", "claude setup-token", capture], env);
    child.on("error", () => { void done(127); });
    child.on("close", (code) => { void done(code ?? 1); });
  });
}

export function defaultConnectDeps(): ConnectDeps {
  return {
    async claudeOnPath(env) { return (await systemProbe(env).which("claude")) !== null; },
    // The copy of the screen lives in the sign-in folder (mode 700, deleted by the core with the attempt).
    runSetupToken: (dir, env) => runCaptured(path.join(dir, ".setup-token.typescript"), { ...env, CLAUDE_CONFIG_DIR: dir }),
    promptToken: () => new Promise((resolve) => {
      process.stdout.write("Paste the token Claude printed above (it will not be shown): ");
      const child = spawn("sh", ["-c", 'stty -echo 2>/dev/null; IFS= read -r t; stty echo 2>/dev/null; printf "%s" "$t"'], {
        stdio: ["inherit", "pipe", "inherit"],
      });
      let out = "";
      child.stdout.on("data", (chunk) => { out += String(chunk); });
      child.on("close", () => { process.stdout.write("\n"); resolve(out); });
    }),
    now: () => Date.now(),
    log: (line) => console.log(line),
  };
}

export async function runConnect(
  positionals: string[],
  flags: Record<string, string | true>,
  env: NodeJS.ProcessEnv,
  deps: ConnectDeps = defaultConnectDeps(),
): Promise<number> {
  if (positionals[0] !== "claude") {
    deps.log("usage: kyoube connect claude   (run the command Connections shows for a Claude subscription)");
    return 2;
  }
  const home = env.PAPERCLIP_HOME?.trim() || "/kyoubeai";
  const dir = typeof flags.dir === "string" ? flags.dir : (env.CLAUDE_CONFIG_DIR ?? "");
  if (!isSignInAttemptDir(dir, home)) {
    deps.log("Start from Connections: add a Claude subscription there and run the command it shows (it ends in `kyoube connect claude`).");
    return 1;
  }
  try {
    await access(dir);
  } catch {
    deps.log("This sign-in has expired or was cancelled. Start it again from Connections and run the new command.");
    return 1;
  }
  if (!(await deps.claudeOnPath(env))) {
    deps.log("Claude Code is not installed. Install it first: kyoube harness install claude");
    return 1;
  }
  deps.log("Signing in to Claude for a one-year token. Follow the link Claude prints and paste the code back here.");
  const { code, transcript } = await deps.runSetupToken(dir, env);
  if (code === CANCELLED) {
    deps.log("Cancelled; nothing was saved. When you are ready, run the command from Connections again.");
    return code;
  }
  if (code !== 0) {
    deps.log(`claude setup-token exited ${code}; nothing was saved`);
    return code;
  }
  const token = extractSetupToken(transcript) ?? (await deps.promptToken()).trim();
  if (!SETUP_TOKEN_RE.test(token)) {
    deps.log("That is not a Claude setup-token (it starts with sk-ant-oat01-). Nothing was saved; run the command again.");
    return 1;
  }
  await writeCredentials(dir, token, deps.now());
  deps.log("Done. The token is valid for a year. Click Connect in the browser to finish.");
  return 0;
}
