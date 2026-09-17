import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";

// Mirrors build.mjs's esbuild `loader: { ".md": "text" }`: `src/manifest.ts`
// imports the skill markdown as a plain string (see `src/md.d.ts`), but
// Vite's own transform pipeline has no built-in notion of that extension and
// otherwise tries (and fails) to parse the markdown as JS. Without this, any
// spec that imports `src/manifest.ts` — directly or transitively — cannot
// run under Vitest at all.
function rawMarkdown(): Plugin {
  return {
    name: "kyoube-raw-markdown",
    transform(_code, id) {
      if (!id.endsWith(".md")) return null;
      return { code: `export default ${JSON.stringify(readFileSync(id, "utf8"))};`, map: null };
    },
  };
}

// `src/ui/apps/bridge.ts` calls the SDK's `isKyoubeRequest` guard at the
// app → host trust boundary, so the bridge spec loads it for real rather than
// stubbing it. The package resolves through its `exports` to `dist/`, which is
// gitignored and not built before `pnpm test`, so the unit suite is pointed at
// the guard's source instead — the same file the SDK's own tests cover, and
// the same file esbuild bundles into `dist/protocol.js` for the shipped UI.
const appSdkSource = fileURLToPath(new URL("../../packages/kyoube-app-sdk/src/protocol.ts", import.meta.url));

export default defineConfig({
  plugins: [rawMarkdown()],
  resolve: { alias: { "@kyoube/app-sdk": appSdkSource } },
  // Ruling P4-R38, narrowing P3-R6: `AppRunner` reads the SDK text through the
  // build-time constant `build.mjs` fills from the SDK's `dist/` (see
  // `src/ui/global.d.ts`), which is why the unit suite could not import the
  // component at all — and so nothing asserted the iframe's `sandbox` or the
  // policy in its `srcdoc`. Stubbing the define with an empty string lets a
  // test render the frame and pin both, while the suite still never reads a
  // built bundle: what goes *into* the srcdoc is the runner's own head, and
  // that is exactly what is under test.
  define: { __KYOUBE_APP_SDK__: '""' },
  test: {
    include: ["tests/unit/**/*.spec.ts", "tests/unit/**/*.spec.tsx"],
    environment: "node",
    // The skeleton ships only the Postgres integration suite (its own config).
    // Without this, `pnpm -r test` fails the whole workspace on "No test files
    // found" until Task 2 adds the first unit spec.
    passWithNoTests: true,
  },
});
