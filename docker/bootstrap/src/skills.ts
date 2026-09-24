import { CoreApiError, type CompanySkill, type CompanySummary, type CoreClient } from "./core-api.js";

/**
 * The two managed skills `kyoube.apps` declares (`skills[]` in its manifest).
 * The worker imports them into every company's skill library by itself; the
 * CLI only checks that it did. Matched by the declared slug, or by the library
 * key upstream derives from the plugin id and skill key, so an admin who
 * renamed a slug does not turn the check red.
 */
export const KYOUBE_SKILLS = [
  { slug: "kyoube-data", keySuffix: "/kyoube-data" },
  { slug: "kyoube-apps", keySuffix: "/kyoube-apps" },
] as const;

/** The Kyoube skill slugs a company's library does not hold. */
export function missingKyoubeSkills(skills: CompanySkill[]): string[] {
  return KYOUBE_SKILLS
    .filter((wanted) => !skills.some((skill) => skill.slug === wanted.slug || skill.key.endsWith(wanted.keySuffix)))
    .map((wanted) => wanted.slug);
}

export interface SkillsStatus {
  companies: CompanySummary[];
  /** Companies still missing a Kyoube skill, with the slugs they lack. */
  missing: Array<{ company: CompanySummary; slugs: string[] }>;
}

/** One pass over every company's library. */
export async function kyoubeSkillsStatus(client: CoreClient): Promise<SkillsStatus> {
  const companies = await client.listCompanies();
  const missing: SkillsStatus["missing"] = [];
  for (const company of companies) {
    const slugs = missingKyoubeSkills(await client.listCompanySkills(company.id));
    if (slugs.length > 0) missing.push({ company, slugs });
  }
  return { companies, missing };
}

export function describeMissing(missing: SkillsStatus["missing"]): string {
  return missing.map(({ company, slugs }) => `${company.name || company.id} (${slugs.join(", ")})`).join(", ");
}

export interface EnsureSkillsOutcome {
  companies: CompanySummary[];
  /** Companies the worker could not import the skills into, with the last error. */
  failed: Array<{ company: CompanySummary; error: string }>;
}

/** A 5xx or a transport failure: the worker is still activating (or the server is mid-restart), so try again. */
function isRetryable(error: unknown): boolean {
  return !(error instanceof CoreApiError) || error.status >= 500;
}

/**
 * Asks the `kyoube.apps` worker to import its skills into every company, one
 * board-scoped route call per company. Runs on every `ensure-plugins` pass —
 * the import is idempotent — so a company that predates the worker gets the
 * skills at the next container start without anyone pressing a button.
 *
 * Right after an install or upgrade the worker is still activating and the
 * route answers 5xx; those are retried until the attempts run out. A 4xx is
 * final (an old worker without the route, say) and reported at once. Failures
 * are reported, never thrown: the plugins themselves are fine.
 */
export async function ensureKyoubeSkills(
  client: CoreClient,
  deps: { sleep: (ms: number) => Promise<void>; log: (line: string) => void; attempts?: number; intervalMs?: number },
): Promise<EnsureSkillsOutcome> {
  const attempts = deps.attempts ?? 30;
  const intervalMs = deps.intervalMs ?? 2000;
  const companies = await client.listCompanies();
  if (companies.length === 0) return { companies, failed: [] };
  const failed: EnsureSkillsOutcome["failed"] = [];
  let pending = companies;
  for (let attempt = 1; ; attempt += 1) {
    const stillPending: CompanySummary[] = [];
    for (const company of pending) {
      try {
        await client.installPluginSkills(company.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isRetryable(error) && attempt < attempts) {
          stillPending.push(company);
          continue;
        }
        failed.push({ company, error: message });
        deps.log(`kyoube: Kyoube skills could not be installed in ${company.name || company.id}: ${message}`);
      }
    }
    pending = stillPending;
    if (pending.length === 0) break;
    await deps.sleep(intervalMs);
  }
  deps.log(`kyoube: Kyoube skills ensured in ${companies.length - failed.length}/${companies.length} companies`);
  if (failed.length > 0) {
    deps.log(
      'kyoube: for the companies above, run "kyoube setup" again once kyoube.apps is ready, ' +
        'or open Company Settings → Data access there and click "Install the Kyoube Data skill"',
    );
  }
  return { companies, failed };
}

/**
 * The worker installs the skills asynchronously as it activates, so right
 * after `ensure-plugins` the libraries can lag by a few seconds. Polls until
 * every company has both skills or the attempts run out.
 */
export async function waitForKyoubeSkills(
  client: CoreClient,
  deps: { sleep: (ms: number) => Promise<void>; attempts?: number; intervalMs?: number },
): Promise<SkillsStatus> {
  const attempts = deps.attempts ?? 30;
  const intervalMs = deps.intervalMs ?? 1000;
  let status = await kyoubeSkillsStatus(client);
  for (let attempt = 1; attempt < attempts && status.missing.length > 0; attempt += 1) {
    await deps.sleep(intervalMs);
    status = await kyoubeSkillsStatus(client);
  }
  return status;
}
