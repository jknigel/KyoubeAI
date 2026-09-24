import esbuild from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await esbuild.build({ entryPoints: ["src/sdk.ts"], outfile: "dist/kyoube-app-sdk.js", bundle: true, format: "iife", platform: "browser", target: ["es2020"], minify: true, logLevel: "info" });
await esbuild.build({ entryPoints: ["src/protocol.ts"], outfile: "dist/protocol.js", bundle: false, format: "esm", platform: "neutral", logLevel: "info" });
await copyFile("types/kyoube.d.ts", "dist/kyoube.d.ts");
// protocol.d.ts for the plugin's typecheck: emit with tsc's declaration output.
// TypeScript 7's tsc rejects CLI file arguments when a tsconfig.json is
// present in the directory (TS5112: "tsconfig.json is present but will not
// be loaded if files are specified on commandline"), so the declaration
// build uses its own project file instead of a bare file-argument invocation.
const { execSync } = await import("node:child_process");
execSync("pnpm exec tsc -p tsconfig.build.json", { stdio: "inherit" });
