/**
 * The `@kyoube/app-sdk` runtime IIFE, inlined into the UI bundle at build time
 * by esbuild's `define` (see `build.mjs`) from
 * `packages/kyoube-app-sdk/dist/kyoube-app-sdk.js`. It is a build-time
 * constant rather than an import because the text is injected into the app's
 * srcdoc as source, not executed in the host page.
 */
declare const __KYOUBE_APP_SDK__: string;
