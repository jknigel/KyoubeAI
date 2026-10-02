import esbuild from "esbuild";
import { rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });

// Worker-side bundles. @kyoube/license is a workspace devDependency, bundled in,
// so `pnpm deploy --prod` ships no copy of it; only the SDK stays external.
await esbuild.build({
  entryPoints: { manifest: "src/manifest.ts", worker: "src/worker.ts" },
  outdir: "dist",
  bundle: true,
  external: ["@paperclipai/plugin-sdk", "@paperclipai/plugin-sdk/*"],
  platform: "node",
  format: "esm",
  target: ["node24"],
  sourcemap: true,
  logLevel: "info",
});

// Browser bundle: everything bundled except what the Paperclip host provides.
await esbuild.build({
  entryPoints: { "ui/index": "src/ui/index.tsx" },
  outdir: "dist",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["es2022"],
  external: ["react", "react-dom", "react/jsx-runtime", "@paperclipai/plugin-sdk/ui"],
  sourcemap: true,
  logLevel: "info",
});
