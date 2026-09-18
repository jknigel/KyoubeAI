import { runWorker } from "@paperclipai/plugin-sdk";
import { createFilesPlugin } from "./plugin.js";

const plugin = createFilesPlugin({});

export default plugin;
runWorker(plugin, import.meta.url);
