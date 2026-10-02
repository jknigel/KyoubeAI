import { runWorker } from "@paperclipai/plugin-sdk";
import { createLicensePlugin } from "./plugin.js";

const plugin = createLicensePlugin();

export default plugin;
runWorker(plugin, import.meta.url);
