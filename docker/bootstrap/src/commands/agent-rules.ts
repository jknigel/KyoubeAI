import { readConfig, resolveConfigPath, type KyoubeConfig } from "../config.js";
import { createCoreClient, type CoreClientOptions } from "../core-api.js";
import { resolveBoardApiKey, resolveBoardKeyPath } from "../key-store.js";
import { createRulesApi, type RulesApi } from "../agent-rules/api.js";
import { applyPass, revertPass } from "../agent-rules/pass.js";
import { failureLines, summarize } from "../agent-rules/report.js";
import { readState, resolveStatePath, writeState } from "../agent-rules/state.js";
import { NO_KEY_EXIT_CODE } from "./ensure-plugins.js";

export const PASS_INTERVAL_MS = 60_000;

/** `KYOUBE_AGENT_RULES=off` turns the loop off; anything else, unset included, leaves it on. */
export function agentRulesEnabled(env: NodeJS.ProcessEnv): boolean {
  return (env.KYOUBE_AGENT_RULES ?? "on").trim().toLowerCase() !== "off";
}

export interface RunAgentRulesDeps {
  readConfig: (filePath: string) => Promise<KyoubeConfig>;
  createApi: (opts: CoreClientOptions) => RulesApi;
  waitForHealth: (apiBase: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  now: () => Date;
  /** Ends `--watch` after this many passes; tests only. */
  maxPasses?: number;
}

const defaultDeps: RunAgentRulesDeps = {
  readConfig,
  createApi: createRulesApi,
  waitForHealth: async (apiBase) => {
    await createCoreClient({ apiBase }).waitForHealth({ timeoutMs: 15 * 60_000, intervalMs: 2000 });
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (line) => console.log(line),
  now: () => new Date(),
};

const USAGE = "usage: kyoube agent-rules --once | --watch | off";

/**
 * Keeps the agent working rules (docs/agent-rules.md) in force: `--once` runs
 * one pass, `--watch` one pass a minute for the life of the container (the
 * entrypoint starts it), and `off` takes everything back out. In `--watch` an
 * unchanged summary or failure is logged once, not every minute.
 */
export async function runAgentRules(
  positionals: string[],
  flags: Record<string, string | true>,
  env: NodeJS.ProcessEnv,
  overrides: Partial<RunAgentRulesDeps> = {},
): Promise<number> {
  const deps = { ...defaultDeps, ...overrides };
  const mode = positionals[0] === "off" ? "off" : flags.once === true ? "once" : flags.watch === true ? "watch" : null;
  if (!mode) {
    deps.log(USAGE);
    return 1;
  }
  if (mode !== "off" && !agentRulesEnabled(env)) {
    deps.log("kyoube: agent rules are off (KYOUBE_AGENT_RULES=off); nothing to do");
    return 0;
  }

  const config = await deps.readConfig(resolveConfigPath(env));
  const statePath = resolveStatePath(config.home);
  const keyPath = resolveBoardKeyPath(config);
  const explicitKey = typeof flags["api-key"] === "string" ? flags["api-key"] : undefined;
  let lastSummary = "";
  let lastFailures = "";
  let passes = 0;

  while (true) {
    try {
      await deps.waitForHealth(config.paperclipApiUrl);
      const apiKey = await resolveBoardApiKey(env, keyPath, explicitKey);
      if (!apiKey) {
        if (mode !== "watch") {
          deps.log("kyoube: no board API key yet — run kyoube setup");
          return NO_KEY_EXIT_CODE;
        }
        if (lastSummary !== "no-key") deps.log("kyoube: agent rules wait for a board API key (kyoube setup)");
        lastSummary = "no-key";
      } else {
        const api = deps.createApi({ apiBase: config.paperclipApiUrl, apiKey });
        const passDeps = { api, now: deps.now };
        const state = await readState(statePath, deps.log);
        // Pre-flight: verify the state file is writable before running the pass, so unwritable
        // state aborts before any remote write happens.
        await writeState(statePath, state);
        const result = mode === "off" ? await revertPass(passDeps, state) : await applyPass(passDeps, state);
        let writeErrorLine = "";
        try {
          await writeState(statePath, result.state);
        } catch (writeError) {
          writeErrorLine = `kyoube: agent rules: could not save ${statePath}: ${writeError instanceof Error ? writeError.message : String(writeError)}`;
        }
        const summary = summarize(result.report);
        const failures = failureLines(result.report).join("\n");
        const allFailures = failures + (writeErrorLine ? (failures ? "\n" : "") + writeErrorLine : "");
        if (mode !== "watch" || summary !== lastSummary) deps.log(summary);
        if (allFailures && (mode !== "watch" || allFailures !== lastFailures)) deps.log(allFailures);
        lastSummary = summary;
        lastFailures = allFailures;
        if (mode !== "watch") return allFailures ? 1 : 0;
      }
    } catch (error) {
      const line = `kyoube: agent rules pass failed: ${error instanceof Error ? error.message : String(error)}`;
      if (mode !== "watch") {
        deps.log(line);
        return 1;
      }
      if (line !== lastFailures) deps.log(line);
      lastFailures = line;
    }
    passes += 1;
    if (deps.maxPasses !== undefined && passes >= deps.maxPasses) return 0;
    await deps.sleep(PASS_INTERVAL_MS);
  }
}
