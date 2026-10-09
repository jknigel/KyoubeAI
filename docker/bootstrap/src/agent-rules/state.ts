import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GovernancePrevious } from "./governance.js";
import type { PassReport } from "./report.js";

/**
 * What `kyoube agent-rules` keeps between passes, on the home volume so it
 * survives image updates: the governance entries it replaced (for `off`) and
 * the last pass's report (for `kyoube doctor`). The guard plugin keeps its own
 * record of the agents it changed, in plugin state.
 */
export interface AgentRulesState {
  version: 1;
  governancePrevious: Record<string, GovernancePrevious>;
  lastPass: PassReport | null;
  /**
   * The last group-only pass, run while KYOUBE_AGENT_RULES=off (ruling R15). Kept apart from
   * `lastPass`, which must go on saying whether the rules are still applied.
   */
  lastGroupsPass?: PassReport | null;
}

export const EMPTY_STATE: AgentRulesState = { version: 1, governancePrevious: {}, lastPass: null };

export function resolveStatePath(home: string): string {
  return path.posix.join(home, ".kyoube", "agent-rules.json");
}

export async function readState(file: string, warn: (line: string) => void = (line) => console.warn(line)): Promise<AgentRulesState> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_STATE);
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AgentRulesState>;
    return {
      version: 1,
      governancePrevious: parsed.governancePrevious && typeof parsed.governancePrevious === "object" ? parsed.governancePrevious : {},
      lastPass: parsed.lastPass && typeof parsed.lastPass === "object" ? parsed.lastPass : null,
      ...(parsed.lastGroupsPass && typeof parsed.lastGroupsPass === "object" ? { lastGroupsPass: parsed.lastGroupsPass } : {}),
    };
  } catch (error) {
    // `--watch` reads this every minute: a hand-broken file must not become a
    // crash loop. Losing it only means `off` removes KyoubeAI's governance
    // entries instead of restoring earlier ones.
    warn(`kyoube: ignoring malformed ${file} (${error instanceof Error ? error.message : String(error)}); starting from an empty agent-rules state`);
    return structuredClone(EMPTY_STATE);
  }
}

/** Written to a temporary file and renamed, so a crash never leaves half a file. */
export async function writeState(file: string, state: AgentRulesState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

/**
 * Fails when the state file's directory cannot be written, without touching the file itself: a
 * pass checks this before any remote write, and rewriting the file here could undo another pass's save.
 */
export async function assertStateWritable(file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const probe = `${file}.${process.pid}.probe`;
  await writeFile(probe, "", { mode: 0o600 });
  await rm(probe, { force: true });
}

/**
 * Merges the governance values recorded on disk into this pass's, per company and per kind, with
 * the value already on disk winning: the first value ever recorded for a kind is the one `off`
 * must restore, whichever of two overlapping passes recorded it.
 */
export function mergeGovernancePrevious(
  onDisk: AgentRulesState["governancePrevious"],
  mine: AgentRulesState["governancePrevious"],
): AgentRulesState["governancePrevious"] {
  const merged: AgentRulesState["governancePrevious"] = {};
  for (const companyId of new Set([...Object.keys(mine), ...Object.keys(onDisk)])) {
    merged[companyId] = { ...(mine[companyId] ?? {}), ...(onDisk[companyId] ?? {}) };
  }
  return merged;
}
