import esbuild from "esbuild";
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

await rm("dist", { recursive: true, force: true });

// The browser SDK text the runner injects into every app's srcdoc. It is read
// as a *string* and handed to esbuild's `define` (below) rather than imported:
// the code runs inside the sandboxed iframe, never in the host page. The
// plugin's `build`/`typecheck` scripts build @kyoube/app-sdk first (ruling
// P3-R6), so a missing bundle means that build was skipped — say so instead of
// failing later with an unresolved `__KYOUBE_APP_SDK__`.
const sdkPath = fileURLToPath(new URL("../../packages/kyoube-app-sdk/dist/kyoube-app-sdk.js", import.meta.url));
const sdkJs = await readFile(sdkPath, "utf8").catch((error) => {
  throw new Error(`Cannot read the app SDK bundle at ${sdkPath} — run "pnpm --filter @kyoube/app-sdk build" first (${error.message})`);
});

// Manifest bundle: the host imports `dist/manifest.js` directly (e.g. before
// this plugin's own node_modules are necessarily on disk), so it must carry
// zod and the inlined skill markdown with it rather than resolving either at
// runtime.
await esbuild.build({
  entryPoints: { manifest: "src/manifest.ts" },
  outdir: "dist",
  bundle: true,
  packages: "bundle",
  platform: "node",
  format: "esm",
  target: ["node24"],
  loader: { ".md": "text" },
  sourcemap: true,
  logLevel: "info",
});

// Worker bundle: dependencies stay external (shipped via pnpm deploy). It
// still needs the `.md` loader: the worker imports the manifest module,
// which inlines the skill markdown.
await esbuild.build({
  entryPoints: { worker: "src/worker.ts" },
  outdir: "dist",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: ["node24"],
  loader: { ".md": "text" },
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
  loader: { ".css": "text" },
  define: { __KYOUBE_APP_SDK__: JSON.stringify(sdkJs) },
  sourcemap: true,
  logLevel: "info",
});
