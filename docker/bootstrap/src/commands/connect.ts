import { spawn } from "node:child_process";
import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { SETUP_TOKEN_RE, extractSetupToken, isSignInAttemptDir, writeCredentials } from "../claude-token.js";
import { systemProbe } from "../harnesses.js";

export interface ConnectDeps {
  claudeOnPath(env: NodeJS.ProcessEnv): Promise<boolean>;
  /** Runs `claude setup-token` attached to the terminal with CLAUDE_CONFIG_DIR=dir, and returns what it printed. */
  runSetupToken(dir: string, env: NodeJS.ProcessEnv): Promise<{ code: number; transcript: string }>;
  /** Reads a pasted token without echoing it. */
  promptToken(): Promise<string>;
  now(): number;
  log(line: string): void;
}

export function defaultConnectDeps(): ConnectDeps {
  return {
    async claudeOnPath(env) { return (await systemProbe(env).which("claude")) !== null; },
    runSetupToken: (dir, env) => new Promise((resolve) => {
      // `script` (util-linux) gives claude a real terminal and keeps a copy of the screen, inside
      // the sign-in folder (mode 700, deleted by the core with the attempt) and removed right after.
      const capture = path.join(dir, ".setup-token.typescript");
      const child = spawn("script", ["-q", "-f", "-e", "-c", "claude setup-token", capture], {
        env: { ...env, CLAUDE_CONFIG_DIR: dir },
        stdio: "inherit",
      });
      const done = async (code: number) => {
        const transcript = await readFile(capture, "utf8").catch(() => "");
        await rm(capture, { force: true });
        resolve({ code, transcript });
      };
      child.on("error", () => { void done(127); });
      child.on("close", (code) => { void done(code ?? 1); });
    }),
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
