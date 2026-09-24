import { runDoctor } from "./commands/doctor.js";
import { runEnsurePlugins } from "./commands/ensure-plugins.js";
import { runSetup } from "./commands/setup.js";
import { runWriteConfig } from "./commands/write-config.js";

export interface ParsedArgs {
  command: string | null;
  flags: Record<string, string | true>;
  positionals: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { command: null, flags: {}, positionals: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        result.flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--") && ["api-key", "api-base"].includes(body)) {
        result.flags[body] = next;
        i += 1;
      } else {
        result.flags[body] = true;
      }
      continue;
    }
    if (result.command === null) result.command = arg;
    else result.positionals.push(arg);
  }
  return result;
}

const USAGE = `kyoube — KyoubeAI bootstrap and diagnostics

Usage: kyoube <command> [flags]

Commands:
  setup                 One-time: log in as instance admin (browser approval), store a board key, install plugins
  ensure-plugins        Install/upgrade Kyoube plugins into the core host (flags: --watch, --api-key <key>, --api-base <url>)
  doctor                Check config, databases, plugins, and the claude/pi/hermes CLIs
  write-config          (internal) Render /kyoubeai/kyoube/config.json from the environment
`;

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.flags.help === true || parsed.command === null) {
    console.log(USAGE);
    return parsed.command === null && parsed.flags.help !== true ? 1 : 0;
  }
  switch (parsed.command) {
    case "setup":
      return runSetup(parsed.flags, env);
    case "ensure-plugins":
      return runEnsurePlugins(parsed.flags, env);
    case "doctor":
      return runDoctor(env);
    case "write-config":
      return runWriteConfig(env);
    default:
      console.log(`Unknown command: ${parsed.command}\n\n${USAGE}`);
      return 1;
  }
}

const isEntrypoint = process.argv[1] !== undefined && /kyoube(\.mjs|\.js)?$/.test(process.argv[1]) && !process.env.VITEST;
if (isEntrypoint) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(`kyoube: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
