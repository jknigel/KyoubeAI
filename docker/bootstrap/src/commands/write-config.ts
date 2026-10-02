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
  const instanceId = await ensureInstanceId(licensePaths(path.posix.join(config.home, "kyoube")).instanceId);
  console.log(`kyoube: instance ID ${instanceId}`);
  console.log(`kyoube: wrote ${filePath} (plugins at ${config.pluginRoot}, api ${config.paperclipApiUrl})`);
  return 0;
}
