import esbuild from "esbuild";
import { rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });

// Worker-side bundles only: this plugin has no UI. Dependencies stay external
// (shipped via pnpm deploy).
await esbuild.build({
  entryPoints: { manifest: "src/manifest.ts", worker: "src/worker.ts" },
  outdir: "dist",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: ["node24"],
  sourcemap: true,
  logLevel: "info",
});
