import { runWorker } from "@paperclipai/plugin-sdk";
import { readKyoubeConfig } from "./kyoube-config.js";
import { createTerminalPlugin } from "./plugin.js";
import { createNodePtySpawner } from "./pty.js";

const plugin = createTerminalPlugin({
  createSpawner: createNodePtySpawner,
  loadKyoubeConfig: () => readKyoubeConfig(),
});

export default plugin;
runWorker(plugin, import.meta.url);
