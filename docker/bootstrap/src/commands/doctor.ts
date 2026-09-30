import { access, readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { readConfig, resolveConfigPath, type KyoubeConfig } from "../config.js";
import { readBoardKey, resolveBoardApiKey, resolveBoardKeyPath } from "../key-store.js";
import { createCoreClient, type CompanySkill, type CompanySummary } from "../core-api.js";
import { describeHarness, harnessesForAdapterTypes, missingHarnesses, probeHarnesses, systemProbe, type HarnessSpec, type HarnessStatus } from "../harnesses.js";
import { describeMissing, KYOUBE_SKILLS, missingKyoubeSkills } from "../skills.js";

export interface Check { name: string; ok: boolean; detail: string }

/**
 * Whether every company's skill library holds both Kyoube skills. A company
 * with none is not an error state for the instance — the worker installs them
 * when the company is created — but a company that is missing one after that
 * is, because its agents cannot be given the skill.
 */
export function skillsCheck(companies: CompanySummary[], skillsByCompany: Map<string, CompanySkill[]>): Check {
  if (companies.length === 0) return { name: "skills", ok: true, detail: "no company yet — installed automatically when one is created" };
  const missing = companies
    .map((company) => ({ company, slugs: missingKyoubeSkills(skillsByCompany.get(company.id) ?? []) }))
    .filter(({ slugs }) => slugs.length > 0);
  const names = KYOUBE_SKILLS.map((skill) => skill.slug).join(" + ");
  if (missing.length === 0) return { name: "skills", ok: true, detail: `${names} present in ${companies.length}/${companies.length} companies` };
  return { name: "skills", ok: false, detail: `missing in ${describeMissing(missing)} — open Company Settings → Data access there and click "Install the Kyoube Data skill"` };
}

function tcpReachable(url: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let host = "";
    let port = 5432;
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      port = Number(parsed.port || 5432);
    } catch {
      resolve({ ok: false, detail: "invalid URL" });
      return;
    }
    const socket = net.connect({ host, port, timeout: 5000 });
    socket.once("connect", () => { socket.destroy(); resolve({ ok: true, detail: `${host}:${port} reachable` }); });
    socket.once("timeout", () => { socket.destroy(); resolve({ ok: false, detail: `${host}:${port} timed out` }); });
    socket.once("error", (error) => { resolve({ ok: false, detail: `${host}:${port} ${error.message}` }); });
  });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * A public deployment (`KYOUBE_DEPLOYMENT_EXPOSURE=public`) with a non-`https://` public URL
 * means the board key, session cookies, and every plugin API call travel in the clear to whoever
 * is on the path — put TLS in front (a reverse proxy or load balancer) and point
 * `KYOUBE_PUBLIC_URL` at the `https://` address before exposing the instance. A `private`
 * deployment (the default, e.g. behind a VPN/tailnet) is not warned about either way: the operator
 * has already decided who can reach it. The function still reads `env.PAPERCLIP_DEPLOYMENT_EXPOSURE`,
 * which is what compose sets inside the container.
 */
export function exposureWarning(env: NodeJS.ProcessEnv, publicUrl: string): string | null {
  if ((env.PAPERCLIP_DEPLOYMENT_EXPOSURE ?? "private") !== "public") return null;
  if (!publicUrl.startsWith("https://")) return `KYOUBE_DEPLOYMENT_EXPOSURE=public but KYOUBE_PUBLIC_URL is ${publicUrl}; put TLS in front and use an https URL`;
  return null;
}

/** Marker `scripts/migrate-from-0.1.sh` leaves in the home volume; while it exists the entrypoint keeps the legacy `/paperclip` path resolvable. */
export const MIGRATION_MARKER = ".migrated-from-paperclip-home";

/** The `.env` keys this release still accepts through compose fallbacks, and what replaces them. */
export const LEGACY_ENV_KEYS: Record<string, string> = {
  PAPERCLIP_PUBLIC_URL: "KYOUBE_PUBLIC_URL",
  PAPERCLIP_DEPLOYMENT_EXPOSURE: "KYOUBE_DEPLOYMENT_EXPOSURE",
  PAPERCLIP_VERSION: "KYOUBE_CORE_VERSION",
};

/**
 * Compose cannot tell the container which `.env` key supplied a value, so it
 * passes the names of the legacy keys that were set (`KYOUBE_LEGACY_ENV_KEYS`,
 * built with `${VAR:+VAR }` substitutions in docker-compose.yml). Informational:
 * the values still work this release.
 */
export function legacyEnvCheck(env: NodeJS.ProcessEnv): Check {
  const keys = (env.KYOUBE_LEGACY_ENV_KEYS ?? "").split(/\s+/).filter(Boolean);
  if (keys.length === 0) return { name: "legacy env", ok: true, detail: "none" };
  const renames = keys.map((key) => `${key} -> ${LEGACY_ENV_KEYS[key] ?? "?"}`).join(", ");
  return { name: "legacy env", ok: true, detail: `${renames} (still honoured; bash scripts/migrate-from-0.1.sh renames them in .env; the old names go away next release)` };
}

export async function legacyHomeLinkCheck(home: string, exists: (file: string) => Promise<boolean> = fileExists): Promise<Check> {
  const marker = path.posix.join(home, MIGRATION_MARKER);
  if (!(await exists(marker))) return { name: "legacy home link", ok: true, detail: "none" };
  return {
    name: "legacy home link",
    ok: true,
    detail: `/paperclip -> ${home} compatibility link active (${marker} exists); run 'bash scripts/migrate-from-0.1.sh --check' and delete the marker when it reports 0 legacy paths`,
  };
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/** One informational line per harness CLI on PATH; the image ships none of its own. */
export function harnessChecks(statuses: HarnessStatus[]): Check[] {
  const installed = statuses.filter((status) => status.path);
  if (installed.length === 0) return [{ name: "harnesses", ok: true, detail: "none installed — see README → Harnesses (kyoube harness install <name>)" }];
  return installed.map((status) => ({ name: `${status.spec.name} cli`, ok: true, detail: describeHarness(status) }));
}

/** Fails when an agent's harness is not installed or does not run: that agent's runs would fail. */
export function harnessesInUseCheck(statuses: HarnessStatus[], inUse: Map<string, number>): Check {
  if (inUse.size === 0) return { name: "harnesses in use", ok: true, detail: "no agents yet" };
  const used = [...inUse.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([type, count]) => `${type} (${count})`).join(", ");
  const missing = missingHarnesses(statuses, inUse.keys());
  const needed = new Set(harnessesForAdapterTypes(inUse.keys()).map((spec) => spec.name));
  const broken = statuses.filter((status) => needed.has(status.spec.name) && status.path && status.version === null).map((status) => status.spec);
  if (missing.length === 0 && broken.length === 0) return { name: "harnesses in use", ok: true, detail: used };
  const fix = (spec: HarnessSpec) => (spec.install ? `kyoube harness install ${spec.name}` : `install ${spec.label}`);
  const problems: string[] = [];
  if (missing.length > 0) problems.push(`not installed: ${missing.map((spec) => spec.name).join(", ")} (${missing.map(fix).join("; ")})`);
  if (broken.length > 0) problems.push(`does not run: ${broken.map((spec) => spec.name).join(", ")} (${broken.map(fix).join("; ")})`);
  return { name: "harnesses in use", ok: false, detail: `${used} — ${problems.join(" — ")}` };
}

/** The packages `sudo apt install` kept (docker/system/apt-record) and whether the last start put them back. */
export function systemPackagesCheck(list: string | null, status: string | null, logPath: string): Check {
  const packages = (list ?? "").split("\n").map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("#"));
  if (/^failed\b/.test(status?.trim() ?? "")) {
    return { name: "system packages", ok: false, detail: `reinstalling the kept packages failed at the last start — see ${logPath} (${packages.join(", ")})` };
  }
  if (packages.length === 0) return { name: "system packages", ok: true, detail: "none kept (sudo apt install <package> keeps one across restarts and updates)" };
  const shown = packages.slice(0, 8).join(", ") + (packages.length > 8 ? `, … (${packages.length - 8} more)` : "");
  return { name: "system packages", ok: true, detail: `${packages.length} kept: ${shown}` };
}

export function claudeCredentialDetail(raw: string | null, filePath: string): string {
  if (raw === null) return `not found (${filePath}) — only agents without an AI connection use it`;
  try {
    const expiresAt = (JSON.parse(raw) as { claudeAiOauth?: { expiresAt?: unknown } }).claudeAiOauth?.expiresAt;
    if (typeof expiresAt === "number") return `present (${filePath}); access token until ${new Date(expiresAt).toISOString()}, which Claude refreshes itself`;
    return `present (${filePath})`;
  } catch {
    return `present but unreadable (${filePath})`;
  }
}

export async function runDoctor(env: NodeJS.ProcessEnv): Promise<number> {
  const checks: Check[] = [];
  const configPath = resolveConfigPath(env);
  let config: KyoubeConfig;
  try {
    config = await readConfig(configPath);
    checks.push({ name: "config", ok: true, detail: configPath });
  } catch (error) {
    checks.push({ name: "config", ok: false, detail: error instanceof Error ? error.message : String(error) });
    return report(checks);
  }

  const warning = exposureWarning(env, config.publicUrl);
  checks.push({ name: "exposure", ok: warning === null, detail: warning ?? "private or https" });
  checks.push(legacyEnvCheck(env));

  const client = createCoreClient({ apiBase: config.paperclipApiUrl });
  try {
    const health = await client.getHealth();
    // `/api/health` redacts `version` for an anonymous caller on an
    // `authenticated` instance (which is what this probe is) but always
    // reports `commit`, so lead with the commit and only add `version` when
    // the full payload came back.
    const parts = [
      `commit ${health.commit ? health.commit.slice(0, 7) : "?"}`,
      `mode ${health.deploymentMode ?? "?"}`,
      `bootstrap ${health.bootstrapStatus ?? "?"}`,
    ];
    if (health.version) parts.unshift(`version ${health.version}`);
    checks.push({ name: "core", ok: health.status === "ok", detail: parts.join(" ") });
  } catch (error) {
    checks.push({ name: "core", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }

  const db = await tcpReachable(config.dataDatabaseUrl);
  checks.push({ name: "kyoube database", ok: db.ok, detail: db.detail });

  const keyPath = resolveBoardKeyPath(config);
  const apiKey = await resolveBoardApiKey(env, keyPath);
  const storedKey = await readBoardKey(keyPath);
  const keyFromEnv = Boolean(env.KYOUBE_BOARD_API_KEY?.trim());
  checks.push({
    name: "board key",
    ok: Boolean(apiKey),
    detail: !apiKey
      ? "missing — run kyoube setup"
      : keyFromEnv
        ? "from environment"
        : `stored (user ${storedKey?.userId ?? "?"})`,
  });

  let inUse: Map<string, number> | null = null;
  if (apiKey) {
    try {
      const authed = createCoreClient({ apiBase: config.paperclipApiUrl, apiKey });
      const plugins = await authed.listPlugins();
      const ours = plugins.filter((plugin) => plugin.pluginKey.startsWith("kyoube."));
      const bad = ours.filter((plugin) => plugin.status !== "ready");
      checks.push({ name: "plugins", ok: ours.length > 0 && bad.length === 0, detail: ours.map((plugin) => `${plugin.pluginKey}@${plugin.version}=${plugin.status}`).join(", ") || "none installed" });
    } catch (error) {
      checks.push({ name: "plugins", ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
    try {
      const authed = createCoreClient({ apiBase: config.paperclipApiUrl, apiKey });
      const companies = await authed.listCompanies();
      const skillsByCompany = new Map<string, CompanySkill[]>();
      for (const company of companies) skillsByCompany.set(company.id, await authed.listCompanySkills(company.id));
      checks.push(skillsCheck(companies, skillsByCompany));
    } catch (error) {
      checks.push({ name: "skills", ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
    try {
      const authed = createCoreClient({ apiBase: config.paperclipApiUrl, apiKey });
      const counts = new Map<string, number>();
      for (const company of await authed.listCompanies()) {
        for (const agent of await authed.listAgents(company.id)) {
          if (agent.status === "terminated" || !agent.adapterType) continue;
          counts.set(agent.adapterType, (counts.get(agent.adapterType) ?? 0) + 1);
        }
      }
      inUse = counts;
    } catch (error) {
      checks.push({ name: "harnesses in use", ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  const harnessEnv = { ...env, HOME: config.home, HERMES_HOME: config.hermesHome };
  const statuses = await probeHarnesses(config.home, systemProbe(harnessEnv));
  checks.push(...harnessChecks(statuses));
  if (inUse) checks.push(harnessesInUseCheck(statuses, inUse));

  const stateDir = path.posix.join(config.home, ".kyoube");
  checks.push(systemPackagesCheck(
    await readOptional(path.posix.join(stateDir, "apt-packages.txt")),
    await readOptional(path.posix.join(stateDir, "apt-restore.status")),
    path.posix.join(stateDir, "apt-restore.log"),
  ));

  const claudeFile = path.posix.join(config.home, ".claude", ".credentials.json");
  checks.push({ name: "claude credentials", ok: true, detail: claudeCredentialDetail(await readOptional(claudeFile), claudeFile) });
  for (const [name, filePath] of [
    ["pi config dir", path.posix.join(config.home, ".pi")],
    ["hermes config", path.posix.join(config.hermesHome, "config.yaml")],
  ] as const) {
    const present = await fileExists(filePath);
    checks.push({ name, ok: true, detail: present ? `present (${filePath})` : `not found (${filePath}) — set up from the Terminal once the harness is installed` });
  }
  checks.push(await legacyHomeLinkCheck(config.home));

  return report(checks);
}

function report(checks: Check[]): number {
  for (const check of checks) {
    console.log(`${check.ok ? "ok  " : "FAIL"} ${check.name.padEnd(20)} ${check.detail}`);
  }
  return checks.every((check) => check.ok) ? 0 : 1;
}
