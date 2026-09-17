import { readFile } from "node:fs/promises";

export const DEFAULT_KYOUBE_CONFIG_PATH = "/kyoubeai/kyoube/config.json";

export interface KyoubeRuntimeConfig {
  home: string;
  hermesHome: string;
  dataDatabaseUrl: string;
  publicUrl: string;
  paperclipApiUrl: string;
}

const FIELDS: Array<keyof KyoubeRuntimeConfig> = ["home", "hermesHome", "dataDatabaseUrl", "publicUrl", "paperclipApiUrl"];

/** Reads the file the Kyoube entrypoint renders at container start (plugin workers receive no environment). */
export async function readKyoubeConfig(
  filePath: string = process.env.KYOUBE_CONFIG_PATH ?? DEFAULT_KYOUBE_CONFIG_PATH,
): Promise<KyoubeRuntimeConfig> {
  const text = await readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // A bare SyntaxError ("Unexpected token …") gives no clue *which* file is broken, and the
    // path is resolved from an env var, so name it: this is the operator's only diagnostic.
    throw new Error(`kyoube config ${filePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`kyoube config ${filePath} is not a JSON object`);
  }
  const raw = parsed as Record<string, unknown>;
  const config: Partial<KyoubeRuntimeConfig> = {};
  for (const field of FIELDS) {
    const value = raw[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`kyoube config ${filePath} is missing ${field}`);
    }
    config[field] = value;
  }
  return config as KyoubeRuntimeConfig;
}
