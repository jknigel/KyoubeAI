import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/kyoube.mjs",
  bundle: true,
  // pg is CommonJS: inlined into this ESM bundle its require("events") fails at runtime. It ships in
  // node_modules (a prod dependency); pg-native is its optional binding.
  external: ["pg", "pg-native"],
  platform: "node",
  format: "esm",
  target: ["node24"],
  sourcemap: false,
  logLevel: "info",
});
