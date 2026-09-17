import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface KyoubeConfig {
  version: 1;
  dataDatabaseUrl: string;
  home: string;
  hermesHome: string;
  pluginRoot: string;
  paperclipApiUrl: string;
  publicUrl: string;
  imageVersion: string;
}

export const DEFAULT_CONFIG_PATH = "/kyoubeai/kyoube/config.json";
export const DEFAULT_API_URL = "http://127.0.0.1:3100";

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveConfigPath(env: NodeJS.ProcessEnv): string {
  return nonEmpty(env.KYOUBE_CONFIG_PATH) ?? DEFAULT_CONFIG_PATH;
}

export function renderConfigFromEnv(env: NodeJS.ProcessEnv): KyoubeConfig {
  const dataDatabaseUrl = nonEmpty(env.KYOUBE_DATABASE_URL);
  if (!dataDatabaseUrl) {
    throw new Error("KYOUBE_DATABASE_URL is required");
  }
  const home = nonEmpty(env.PAPERCLIP_HOME) ?? "/kyoubeai";
  const paperclipApiUrl = trimSlash(nonEmpty(env.PAPERCLIP_API_URL) ?? DEFAULT_API_URL);
  return {
    version: 1,
    dataDatabaseUrl,
    home,
    hermesHome: nonEmpty(env.HERMES_HOME) ?? path.posix.join(home, ".hermes"),
    pluginRoot: nonEmpty(env.KYOUBE_PLUGIN_ROOT) ?? "/opt/kyoube/plugins",
    paperclipApiUrl,
    publicUrl: trimSlash(nonEmpty(env.PAPERCLIP_PUBLIC_URL) ?? DEFAULT_API_URL),
    imageVersion: nonEmpty(env.KYOUBE_VERSION) ?? "dev",
  };
}

export async function writeConfig(filePath: string, config: KyoubeConfig): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

const REQUIRED_STRING_FIELDS: Array<keyof KyoubeConfig> = [
  "dataDatabaseUrl",
  "home",
  "hermesHome",
  "pluginRoot",
  "paperclipApiUrl",
  "publicUrl",
  "imageVersion",
];

export async function readConfig(filePath: string): Promise<KyoubeConfig> {
  const raw = JSON.parse(await readFile(filePath, "utf8")) as Partial<KyoubeConfig>;
  if (raw.version !== 1) {
    throw new Error(`Unsupported kyoube config version in ${filePath}`);
  }
  for (const field of REQUIRED_STRING_FIELDS) {
    const value = raw[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`kyoube config ${filePath} is missing ${field}`);
    }
  }
  return raw as KyoubeConfig;
}
