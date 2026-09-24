/**
 * Every fix KyoubeAI applies to the upstream core at image build time.
 *
 * This list is meant to be empty. An entry exists only while an upstream bug
 * is fixed here first and the same fix is on its way upstream (`upstream`
 * names the issue or pull request); it is deleted the moment a core bump
 * carries the upstream fix. `apply.mjs` enforces the exit: each pattern must
 * match exactly `expect` times across the files it names, so a core release
 * that no longer has the bug — or that changed the code's shape — fails the
 * build with the patch's id, which is the cue to remove (or redo) it.
 *
 * Patterns are written against the compiled, minified bundle the image ships
 * (`ui/dist`), so they anchor on string literals and code shape, never on
 * minifier-chosen identifier names. See CONTRIBUTING.md, "Never patch the core".
 */

/**
 * The label of the control the `onboarding-skip-harness-*` patches add under
 * a failed Connect step. Exported for the tests.
 */
export const SKIP_HARNESS_LABEL = "Skip for now and connect the harness later from the Terminal page";

export const PATCHES = [
  {
    id: "pi-transcript-non-assistant-messages",
    title: "pi adapter: do not render tool results and the wake prompt as agent text",
    upstream: "https://github.com/paperclipai/paperclip (packages/adapters/pi-local/src/ui/parse-stdout.ts, message_end handler; PR pending)",
    // pi emits `message_end` for every message it appends to its session —
    // the user turn (the "Resume Delta" wake prompt) and each `toolResult`
    // (raw command output) as well as the assistant's own text — and the
    // parser turned all of them into `assistant` transcript entries, so the
    // task chat showed the prompt and every tool output as agent bubbles in
    // the body font (tool output twice: it is also threaded onto its tool
    // card). Only an assistant message may become agent text.
    // Since core 2026.916 the pi transcript parser is code-split into a chunk
    // whose name the bundler picks (AiConnectionCredentialStep-*.js in
    // 2026.916.1), so the patch looks in every chunk; `expect` still pins it
    // to exactly one match.
    files: ["ui/dist/assets/*.js"],
    pattern: /if\((\w+)==="message_end"\)\{const (\w+)=(\w+)\((\w+)\.message\);if\(\2\)\{/g,
    replacement: 'if($1==="message_end"){const $2=$3($4.message);if($2&&$2.role!=="assistant")return[];if($2){',
    expect: 1,
  },
  // ── onboarding: "Skip for now" under a failed Connect step ──────────────
  // Step 2 of the first-run agent wizard ("Connect a model") will not hire the
  // agent until the chosen harness is signed in. On a fresh KyoubeAI install
  // nothing is: the server runs in `authenticated` mode, where the wizard's
  // Claude/OpenAI subscription sign-in ends in "Only the local operator can
  // connect this machine's CLI account" (upstream only lets the implicit local
  // operator of a `local_trusted` instance finish it), and the Terminal page
  // where `claude login` works sits behind the wizard, which has no close
  // button. An API key still works; a subscription has no way forward.
  //
  // Four patches, one feature. The footer gets a "Skip for now" button while
  // step 4 shows an error; it calls the step's primary action with `true`,
  // which goes straight to the hire handler with `true`, which then skips the
  // two checks that need a signed-in harness (the local sign-in and the
  // environment test). Both handlers are plain function declarations, so
  // `arguments[0]` reads that flag without the pattern reaching a parameter
  // list, and every existing call passes nothing (or a click event), so only
  // the new button skips. The agent is created with the chosen harness and
  // no credential; signing in from the Terminal page afterwards is enough.
  {
    id: "onboarding-skip-harness-primary",
    title: "onboarding: the Connect step's primary action accepts a skip flag",
    upstream: "https://github.com/paperclipai/paperclip (ui/src/components/OnboardingWizard.tsx, handleConnectStepPrimary; feature request pending)",
    files: ["ui/dist/assets/*.js"],
    pattern: /function ([\w$]+)\(\)\{if\(([\w$]+)==="ready"&&([\w$]+)\)\{([\w$]+)&&window\.open\(\4,"_blank","noreferrer,noopener"\),([\w$]+)\("waiting"\);return\}\2!=="connecting"&&\(([\w$]+)\|\|([\w$]+)\(\)\)\}/g,
    replacement: 'function $1(){if(arguments[0]===!0){$7(!0);return}if($2==="ready"&&$3){$4&&window.open($4,"_blank","noreferrer,noopener"),$5("waiting");return}$2!=="connecting"&&($6||$7())}',
    expect: 1,
  },
  {
    id: "onboarding-skip-harness-login",
    title: "onboarding: a skipped hire does not start the subscription sign-in",
    upstream: "https://github.com/paperclipai/paperclip (ui/src/components/OnboardingWizard.tsx, handleGiveHeartbeat, localLogin.connect(); feature request pending)",
    files: ["ui/dist/assets/*.js"],
    pattern: /if\(([\w$]+)!=="api"&&([\w$]+)&&([\w$]+)&&!([\w$]+)\(\)&&!([\w$]+)&&!([\w$]+)\.storedLogin\.data\)\{if\(await ([\w$]+)\.connect\(\),/g,
    replacement: 'if(arguments[0]!==!0&&$1!=="api"&&$2&&$3&&!$4()&&!$5&&!$6.storedLogin.data){if(await $7.connect(),',
    expect: 1,
  },
  {
    id: "onboarding-skip-harness-gate",
    title: "onboarding: a skipped hire does not run the environment test",
    upstream: "https://github.com/paperclipai/paperclip (ui/src/components/OnboardingWizard.tsx, handleGiveHeartbeat, blocksAgentCreate gate; feature request pending)",
    files: ["ui/dist/assets/*.js"],
    pattern: /if\(([\w$]+)\)\{const ([\w$]+)=(\([^;]*?\))\?\?await ([\w$]+)\(([\w$,]*)\);if\(!\2\|\|!([\w$]+)\(\)\)return;if\(([\w$]+)\(\2\)\)\{([\w$]+)\(\2\.status==="fail"\?"The environment test failed\. Fix the reported checks before you hire this agent\.":"No working authentication was found\. Fix the reported checks before you hire this agent\."\);return\}\}/g,
    replacement: 'if($1&&arguments[0]!==!0){const $2=$3??await $4($5);if(!$2||!$6())return;if($7($2)){$8($2.status==="fail"?"The environment test failed. Fix the reported checks before you hire this agent.":"No working authentication was found. Fix the reported checks before you hire this agent.");return}}',
    expect: 1,
  },
  {
    id: "onboarding-skip-harness-button",
    title: "onboarding: offer \"Skip for now\" under an error on the Connect step",
    upstream: "https://github.com/paperclipai/paperclip (ui/src/components/OnboardingWizard.tsx, error block and FooterNav; feature request pending)",
    // Anchors on the error line and on the footer's own literals ("Continue",
    // "Connecting", the step numbers), and captures the step ($5), the busy
    // flag ($7) and the Connect step's primary action ($8) from the footer's
    // props. The footer call is re-emitted verbatim ($3).
    files: ["ui/dist/assets/*.js"],
    pattern: /([\w$]+)&&\(0,([\w$]+)\.jsx\)\("div",\{className:"mt-3",children:\(0,\2\.jsx\)\("p",\{className:"text-xs text-destructive",children:\1\}\)\}\),(\(([\w$]+)\|\|([\w$]+)===1\)&&\(0,\2\.jsx\)\(([\w$]+),\{onBack:[^;]*?,primaryLabel:\5===1\?"Continue":[^;]*?,loadingLabel:\5===1\?"Creating\.\.\.":\5===4\?"Connecting":"Launching\.\.\.",loading:\5===3\|\|\5===4\?!1:([\w$]+),primaryDisabled:[^;]*?,onPrimary:\(\)=>\{\5===1\?[\w$]+\(\):\5===3\?[\w$]+\(4\):\5===4\?([\w$]+)\(\):[\w$]+\(\)\}\}\))/g,
    replacement:
      '$1&&(0,$2.jsx)("div",{className:"mt-3",children:(0,$2.jsx)("p",{className:"text-xs text-destructive",children:$1})}),' +
      `$5===4&&$1&&(0,$2.jsx)("div",{className:"mt-2",children:(0,$2.jsx)("button",{type:"button",className:"text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground transition-colors",disabled:$7,onClick:()=>$8(!0),children:${JSON.stringify(SKIP_HARNESS_LABEL)}})}),` +
      "$3",
    expect: 1,
  },
];
