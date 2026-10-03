import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ensureInstanceId, licensePaths } from "@kyoube/license";
import { renderConfigFromEnv, resolveConfigPath, writeConfig } from "../config.js";

/** Renders /kyoubeai/kyoube/config.json from the container environment. Runs as the `node` user from the entrypoint. */
export async function runWriteConfig(env: NodeJS.ProcessEnv): Promise<number> {
  const config = renderConfigFromEnv(env);
  const filePath = resolveConfigPath(env);
  await mkdir(config.hermesHome, { recursive: true });
  await writeConfig(filePath, config);
  try {
    const instanceId = await ensureInstanceId(licensePaths(path.posix.join(config.home, "kyoube")).instanceId);
    console.log(`kyoube: instance ID ${instanceId}`);
  } catch (error) {
    console.log(`kyoube: could not create the instance ID (${error instanceof Error ? error.message : String(error)}); instance-bound licence keys won't apply until it exists`);
  }
  console.log(`kyoube: wrote ${filePath} (plugins at ${config.pluginRoot}, api ${config.paperclipApiUrl})`);
  return 0;
}
