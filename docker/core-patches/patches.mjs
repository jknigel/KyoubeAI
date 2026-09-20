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
 * What the first-run wizard says under a failed harness probe once the
 * `onboarding-skip-harness-*` pair is applied. Shared by both patches: the
 * handler writes it, the button shows only while the error reads exactly this.
 */
export const SKIP_HARNESS_MESSAGE =
  "This harness is not connected yet: the environment test failed. Fix the reported checks and press Connect again, or skip for now and connect it later from the Terminal page.";
export const SKIP_HARNESS_LABEL = "Skip for now and connect the harness later";

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
    files: ["ui/dist/assets/index-*.js"],
    pattern: /if\((\w+)==="message_end"\)\{const (\w+)=(\w+)\((\w+)\.message\);if\(\2\)\{/g,
    replacement: 'if($1==="message_end"){const $2=$3($4.message);if($2&&$2.role!=="assistant")return[];if($2){',
    expect: 1,
  },
  {
    id: "onboarding-skip-harness-handler",
    title: "onboarding: a failed environment test no longer blocks the first hire when the user chooses to skip",
    upstream: "https://github.com/paperclipai/paperclip (ui/src/components/OnboardingWizard.tsx, handleGiveHeartbeat; feature request pending)",
    // Step 4 of the first-run wizard ("Connect") probes the chosen harness and
    // refuses to hire the agent while the probe fails. On a fresh KyoubeAI
    // install every harness fails it — nobody has run `claude login` yet — and
    // the only place to log in, the Terminal page, sits behind the wizard, so a
    // new instance has no way forward except an API key in `.env`.
    //
    // The handler is a plain `async function` declaration, so `arguments[0]`
    // reads its first argument without the pattern having to reach the
    // declaration (which carries no literal to anchor on). Every existing call
    // passes nothing or a click event, so only an explicit `true` skips the
    // probe; the companion patch below is what passes it. The failure message
    // is replaced with one that says the skip exists and where to connect
    // later — that literal is also how the companion finds the failure.
    files: ["ui/dist/assets/index-*.js"],
    pattern:
      /if\((\w+)\)\{const (\w+)=\((\w+)&&\3\.status!=="fail"\?\3:null\)\?\?await (\w+)\(\);if\(!\2\)return;if\(\2\.status==="fail"\)\{(\w+)\("The environment test failed\. Fix the reported checks before you hire this agent\."\);return\}\}/g,
    replacement:
      `if($1&&arguments[0]!==!0){const $2=($3&&$3.status!=="fail"?$3:null)??await $4();if(!$2)return;if($2.status==="fail"){$5(${JSON.stringify(SKIP_HARNESS_MESSAGE)});return}}`,
    expect: 1,
  },
  {
    id: "onboarding-skip-harness-button",
    title: "onboarding: offer \"Skip for now\" under a failed environment test",
    upstream: "https://github.com/paperclipai/paperclip (ui/src/components/OnboardingWizard.tsx, step 4 error block; feature request pending)",
    // Renders the skip control between the wizard's error line and its footer
    // navigation, only on step 4 and only while the error is the one the
    // handler patch writes. Clicking it calls the hire handler with `true`,
    // which the handler patch reads as "skip the probe"; the handler clears
    // the error first, so the control disappears as the hire starts. A plain
    // <button> in the same classes as the step's "Advanced settings" toggle,
    // because the wizard's Button component has no literal to anchor on here.
    // The footer props are captured whole ($5) so the call is re-emitted
    // verbatim; the inner back-references only pin the shape (step, loading
    // and hire-handler identifiers) the replacement needs.
    files: ["ui/dist/assets/index-*.js"],
    pattern:
      /(\w+)&&((?:\(0,)?[\w$.]+?\.jsx\)?)\("div",\{className:"mt-3",children:\2\("p",\{className:"text-xs text-destructive",children:\1\}\)\}\),(\w+)&&\2\((\w+),(\{onBack:\w+\(\{currentStep:(\w+),entryStep:\w+\}\)\?\(\)=>\w+\(\w+\(\6\)\):void 0,primaryLabel:\6===3\?"Next":\6===4\?"Connect":"Get started",loadingLabel:\6===4\?"Connecting\.\.\.":"Launching\.\.\.",loading:\6===3\?!1:(\w+),primaryDisabled:[^,]*,onPrimary:\(\)=>\{\6===3\?\w+\(4\):\6===4\?(\w+)\(\):\w+\(\)\}\})\)/g,
    replacement:
      `$1&&$2("div",{className:"mt-3",children:$2("p",{className:"text-xs text-destructive",children:$1})}),` +
      `$6===4&&$1===${JSON.stringify(SKIP_HARNESS_MESSAGE)}&&$2("div",{className:"mt-2",children:$2("button",{type:"button",className:"text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground transition-colors",disabled:$7,onClick:()=>$8(!0),children:${JSON.stringify(SKIP_HARNESS_LABEL)}})}),` +
      `$3&&$2($4,$5)`,
    expect: 1,
  },
];
