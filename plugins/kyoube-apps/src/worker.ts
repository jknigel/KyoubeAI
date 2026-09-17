import { runWorker } from "@paperclipai/plugin-sdk";
import { migrationsDirFrom } from "./db/migrate.js";
import { readKyoubeConfig } from "./kyoube-config.js";
import { createAppsPlugin } from "./plugin.js";

const plugin = createAppsPlugin({
  loadKyoubeConfig: () => readKyoubeConfig(),
  migrationsDir: migrationsDirFrom(import.meta.url),
});

export default plugin;
runWorker(plugin, import.meta.url);
