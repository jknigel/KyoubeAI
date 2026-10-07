import { readFile } from "node:fs/promises";

/** Rendered by the entrypoint at container start (`kyoube write-config`); plugin workers receive no environment. */
export const KYOUBE_CONFIG_PATH = "/kyoubeai/kyoube/config.json";
/** Written only by scripts/smoke.sh; `kyoube doctor` fails a public instance on which it exists. */
export const PUSH_TEST_ENDPOINT_PATH = "/kyoubeai/kyoube/push-test-endpoint";

/** The instance's public URL from config.json, or null when the file is missing or unreadable (a dev run). */
export async function readPublicUrl(filePath = KYOUBE_CONFIG_PATH): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as { publicUrl?: unknown };
    return typeof parsed.publicUrl === "string" && parsed.publicUrl.length > 0 ? parsed.publicUrl : null;
  } catch {
    return null;
  }
}

/** The smoke test's receiver URL, read fresh on every call, or null (the normal case). */
export async function readTestEndpoint(filePath = PUSH_TEST_ENDPOINT_PATH): Promise<string | null> {
  try {
    const value = (await readFile(filePath, "utf8")).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
