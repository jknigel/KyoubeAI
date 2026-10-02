import esbuild from "esbuild";
import { execSync } from "node:child_process";
import { rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });

// The library the kyoube CLI, the licence plugin and KyoubeAI-Admin import.
await esbuild.build({ entryPoints: ["src/index.ts"], outfile: "dist/index.js", bundle: true, platform: "node", format: "esm", target: ["node24"], logLevel: "info" });

// The seat check the core's sign-up hook imports from /opt/kyoube/license/enforce.mjs
// (docker/core-patches/patches.mjs, license-seat-limit-hook): one self-contained file
// with no dependencies, so it loads from a path outside any node_modules tree.
await esbuild.build({ entryPoints: ["src/enforce-entry.ts"], outfile: "dist/enforce.mjs", bundle: true, platform: "node", format: "esm", target: ["node24"], logLevel: "info" });

// Declarations for the workspace packages' typecheck. TypeScript 7's tsc rejects file
// arguments next to a tsconfig.json (TS5112), so they come from a project file.
execSync("pnpm exec tsc -p tsconfig.build.json", { stdio: "inherit" });
