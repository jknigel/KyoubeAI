/**
 * G1 (docs/agent-rules.md): the company setting that makes an agent's approval
 * card answerable by a person only. Core's `companies.interactionResolverGovernance`
 * holds, per card kind, a default resolver policy and a cap that only ever
 * tightens what an agent asks for (issue-thread-interactions.ts, core 2026.916.1).
 */

export const GOVERNED_KINDS = [
  "request_confirmation",
  "request_checkbox_confirmation",
  "request_item_verdicts",
  "ask_user_questions",
  "suggest_tasks",
] as const;

export type GovernedKind = (typeof GOVERNED_KINDS)[number];

export interface KindGovernance {
  defaultPolicy?: string;
  cap?: string;
}

/** The whole setting as the core stores it; kinds KyoubeAI does not govern pass through untouched. */
export type Governance = Record<string, KindGovernance | undefined>;

/** What each governed kind held before KyoubeAI changed it; `null` means the kind had no entry. */
export type GovernancePrevious = Partial<Record<GovernedKind, KindGovernance | null>>;

const PEOPLE_ONLY = "human_only";

function isPeopleOnly(entry: KindGovernance | undefined): boolean {
  return entry?.defaultPolicy === PEOPLE_ONLY && entry.cap === PEOPLE_ONLY;
}

export interface GovernancePlan {
  next: Governance;
  changed: boolean;
  /** The entries this plan replaces, for `off` to put back. */
  previous: GovernancePrevious;
}

export function planGovernance(current: Governance | null | undefined): GovernancePlan {
  const next: Governance = { ...(current ?? {}) };
  const previous: GovernancePrevious = {};
  for (const kind of GOVERNED_KINDS) {
    const entry = next[kind];
    if (isPeopleOnly(entry)) continue;
    previous[kind] = entry ? { ...entry } : null;
    next[kind] = { ...(entry ?? {}), defaultPolicy: PEOPLE_ONLY, cap: PEOPLE_ONLY };
  }
  return { next, changed: Object.keys(previous).length > 0, previous };
}

/**
 * The setting with KyoubeAI's entries taken back out. With a record of what
 * was there before, each recorded kind gets its old entry back. Without one
 * (the state file was lost), only entries that are exactly what KyoubeAI writes
 * are removed, so a setting someone chose with more in it survives.
 */
export function revertGovernance(current: Governance | null | undefined, previous: GovernancePrevious | undefined): { next: Governance; changed: boolean } {
  const next: Governance = { ...(current ?? {}) };
  let changed = false;
  for (const kind of GOVERNED_KINDS) {
    if (previous) {
      if (!(kind in previous)) continue;
      const before = previous[kind];
      if (before) next[kind] = { ...before };
      else delete next[kind];
      changed = true;
      continue;
    }
    const entry = next[kind];
    if (isPeopleOnly(entry) && Object.keys(entry ?? {}).length === 2) {
      delete next[kind];
      changed = true;
    }
  }
  return { next, changed };
}
