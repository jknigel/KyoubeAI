import { mkdir } from "node:fs/promises";
import { renderConfigFromEnv, resolveConfigPath, writeConfig } from "../config.js";

/** Renders /kyoubeai/kyoube/config.json from the container environment. Runs as the `node` user from the entrypoint. */
export async function runWriteConfig(env: NodeJS.ProcessEnv): Promise<number> {
  const config = renderConfigFromEnv(env);
  const filePath = resolveConfigPath(env);
  await mkdir(config.hermesHome, { recursive: true });
  await writeConfig(filePath, config);
  console.log(`kyoube: wrote ${filePath} (plugins at ${config.pluginRoot}, api ${config.paperclipApiUrl})`);
  return 0;
}
