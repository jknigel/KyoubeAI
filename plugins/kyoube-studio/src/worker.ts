import { runWorker } from "@paperclipai/plugin-sdk";
import { createStudioPlugin } from "./plugin.js";

const plugin = createStudioPlugin();

export default plugin;
runWorker(plugin, import.meta.url);
