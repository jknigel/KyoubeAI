import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";

/**
 * Where gosu may be: the image's own system directories (the core image has /usr/sbin/gosu). Never a directory on
 * PATH such as /kyoubeai/.local/bin, which agents can write, because this runs as root.
 */
export const GOSU_PATHS = ["/usr/sbin/gosu", "/usr/local/sbin/gosu", "/usr/local/bin/gosu", "/usr/bin/gosu", "/sbin/gosu", "/bin/gosu"];

/** Set on the re-executed process, so a gosu that did not switch users cannot loop. */
export const AS_NODE_ENV = "KYOUBE_AS_NODE";

/**
 * Commands that write what the server and its agents later use as `node`: a harness install (into
 * /kyoubeai/.local and ~/.npm) and a Claude sign-in's token. Run as root (`docker compose exec app ...` is root), they
 * leave root-owned files that the Terminal and the agents cannot write.
 * `agent-rules` writes its state file, which the background loop, running as node, must
 * be able to rewrite.
 * `license` and `users` write the licence key and the user snapshot, which the licence plugin's worker and the
 * background loop, both node, read and rewrite.
 */
export function writesAsNode(command: string | null, positionals: string[]): boolean {
  return command === "connect" || command === "agent-rules" || command === "license" || command === "users" || (command === "harness" && positionals[0] === "install");
}

export type NodeUserPlan =
  | { kind: "run" }
  | { kind: "reexec"; file: string; args: string[] }
  | { kind: "refuse"; message: string };

export interface NodeUserInput {
  command: string | null;
  positionals: string[];
  /** process.getuid(), or undefined where there is none. */
  uid: number | undefined;
  /** The gosu found (findGosu), or null. */
  gosu: string | null;
  /** The node binary running this program (process.execPath). */
  execPath: string;
  /** This program's file (process.argv[1]). */
  script: string | undefined;
  /** The arguments this program was given, to pass on unchanged. */
  argv: string[];
  /** True when AS_NODE_ENV is set: this process is already the re-executed one. */
  reexeced: boolean;
}

/** Decides whether this run continues as is, re-executes itself as `node` through gosu, or refuses. */
export function planNodeUser(input: NodeUserInput): NodeUserPlan {
  if (input.uid !== 0 || !writesAsNode(input.command, input.positionals)) return { kind: "run" };
  const what = input.command === "harness" ? "kyoube harness install" : `kyoube ${input.command}`;
  if (input.reexeced) {
    return { kind: "refuse", message: `${what} is still running as root after switching to the node user; nothing was changed. Run it from the Terminal page, or with docker compose exec -u node app kyoube ...` };
  }
  if (!input.gosu || !input.script) {
    return { kind: "refuse", message: `${what} must run as the node user, and gosu, which switches to it, is not in this image; nothing was changed. Run it from the Terminal page, or with docker compose exec -u node app kyoube ...` };
  }
  return { kind: "reexec", file: input.gosu, args: ["node", input.execPath, input.script, ...input.argv] };
}

/** The first of GOSU_PATHS that is executable, or null. */
export function findGosu(isExecutable: (file: string) => boolean = executable): string | null {
  return GOSU_PATHS.find((file) => isExecutable(file)) ?? null;
}

function executable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Runs FILE ARGS attached to this terminal and resolves with its exit code. */
export function reexec(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { env: { ...env, [AS_NODE_ENV]: "1" }, stdio: "inherit" });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
}
