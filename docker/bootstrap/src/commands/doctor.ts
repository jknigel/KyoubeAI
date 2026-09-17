import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { readConfig, resolveConfigPath, type KyoubeConfig } from "../config.js";
import { readBoardKey, resolveBoardApiKey, resolveBoardKeyPath } from "../key-store.js";
import { createCoreClient, type CompanySkill, type CompanySummary } from "../core-api.js";
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

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 20_000);
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.on("error", (error) => { clearTimeout(timer); resolve({ ok: false, output: error.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, output: output.trim() }); });
  });
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
  }

  const harnessEnv = { ...env, HOME: config.home, HERMES_HOME: config.hermesHome };
  for (const [name, args] of [["claude", ["--version"]], ["pi", ["--version"]], ["hermes", ["--version"]]] as const) {
    const result = await runCommand(name, [...args], harnessEnv);
    checks.push({ name: `${name} cli`, ok: result.ok, detail: result.output.split("\n")[0] ?? "" });
  }

  const credentialHints: Array<[string, string]> = [
    ["claude credentials", path.posix.join(config.home, ".claude", ".credentials.json")],
    ["pi config dir", path.posix.join(config.home, ".pi")],
    ["hermes config", path.posix.join(config.hermesHome, "config.yaml")],
  ];
  for (const [name, filePath] of credentialHints) {
    const present = await fileExists(filePath);
    checks.push({ name, ok: true, detail: present ? `present (${filePath})` : `not found (${filePath}) — authenticate from the Terminal page or set provider API keys` });
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
