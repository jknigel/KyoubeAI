import { spawn } from "node:child_process";
import {
  HARNESSES, describeHarness, findHarness, harnessesForAdapterTypes, missingHarnesses,
  probeHarness, probeHarnesses, systemProbe, type ProbeDeps,
} from "../harnesses.js";

export interface HarnessCommandDeps {
  probe: ProbeDeps;
  /** Runs an installer command line with the caller's environment, attached to the terminal. */
  runInstaller(command: string): Promise<number>;
  log(line: string): void;
}

const NAMES = HARNESSES.map((spec) => spec.name).join(", ");

export function defaultHarnessDeps(env: NodeJS.ProcessEnv): HarnessCommandDeps {
  return {
    probe: systemProbe(env),
    runInstaller: (command) => new Promise((resolve) => {
      const child = spawn("bash", ["-o", "pipefail", "-c", command], { env, stdio: "inherit" });
      child.on("error", () => resolve(127));
      child.on("close", (code) => resolve(code ?? 1));
    }),
    log: (line) => console.log(line),
  };
}

export async function runHarness(positionals: string[], env: NodeJS.ProcessEnv, deps: HarnessCommandDeps = defaultHarnessDeps(env)): Promise<number> {
  const [sub, ...rest] = positionals;
  const home = env.PAPERCLIP_HOME?.trim() || "/kyoubeai";
  switch (sub) {
    case "list": {
      for (const status of await probeHarnesses(home, deps.probe)) deps.log(`${status.spec.name.padEnd(9)} ${describeHarness(status)}`);
      return 0;
    }
    case "which": {
      const spec = findHarness(rest[0] ?? "");
      if (!spec) { deps.log(`unknown harness '${rest[0] ?? ""}' (known: ${NAMES})`); return 2; }
      const found = await deps.probe.which(spec.name);
      if (!found) return 1;
      deps.log(found);
      return 0;
    }
    case "missing": {
      const statuses = await probeHarnesses(home, deps.probe, harnessesForAdapterTypes(rest));
      for (const spec of missingHarnesses(statuses, rest)) deps.log(spec.name);
      return 0;
    }
    case "install": {
      const spec = findHarness(rest[0] ?? "");
      if (!spec) { deps.log(`usage: kyoube harness install <name>   (known: ${NAMES})`); return 2; }
      if (!spec.install) {
        deps.log(`KyoubeAI has no installer for ${spec.label}; install it from its own instructions so that '${spec.name}' lands in ${home}/.local/bin`);
        return 2;
      }
      deps.log(`==> ${spec.install}`);
      const code = await deps.runInstaller(spec.install);
      if (code !== 0) { deps.log(`the ${spec.label} installer exited ${code}`); return code; }
      const status = await probeHarness(spec, home, deps.probe);
      if (!status.path) {
        deps.log(`the installer finished, but '${spec.name}' is not on PATH; its output above says where it put the command`);
        return 1;
      }
      if (status.origin !== "yours") deps.log(`note: ${status.path} comes first on PATH, not your install in ${home}/.local/bin`);
      deps.log(`${spec.name}: ${describeHarness(status)}`);
      return 0;
    }
    default:
      deps.log("usage: kyoube harness list | which <name> | missing <adapterType...> | install <name>");
      return 2;
  }
}
