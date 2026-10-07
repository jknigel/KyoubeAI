import { runWorker } from "@paperclipai/plugin-sdk";
import { createNotifyPlugin } from "./plugin.js";

const plugin = createNotifyPlugin();

export default plugin;
runWorker(plugin, import.meta.url);
