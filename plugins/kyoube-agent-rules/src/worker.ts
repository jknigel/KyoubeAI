import { runWorker } from "@paperclipai/plugin-sdk";
import { createAgentRulesPlugin } from "./plugin.js";

const plugin = createAgentRulesPlugin();

export default plugin;
runWorker(plugin, import.meta.url);
