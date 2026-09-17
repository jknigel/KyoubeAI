import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/kyoube.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: ["node24"],
  sourcemap: false,
  logLevel: "info",
});
