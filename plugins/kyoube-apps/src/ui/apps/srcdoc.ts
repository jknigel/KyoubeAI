/**
 * The policy every app document runs under (ruling P3-R2, spec §8.4 plus
 * `form-action`/`base-uri`). The sandbox attribute on the iframe keeps app
 * code out of the host page, but it does not stop the app reaching the
 * network — this policy is the only thing that does. `default-src 'none'` and
 * `connect-src 'none'` leave an app no way to talk to a server at all (its
 * data comes through the postMessage bridge instead); the two `'unsafe-inline'`
 * sources allow only the markup the app itself ships (no remote code, and no
 * `'unsafe-eval'`, so `eval`/`new Function` throw); `data:` and `blob:` images
 * plus `data:` fonts keep self-contained assets working; and
 * `form-action 'none'` / `base-uri 'none'` close the two navigation-shaped
 * exfiltration channels a policy without them would leave open.
 */
export const APP_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";

/**
 * Position just after a leading doctype, so a prepended head does not push
 * the document into quirks mode. The only inert prefix is a doctype preceded
 * by nothing but HTML ASCII whitespace — the tokenizer's whitespace class is
 * exactly `[\t\n\f\r ]` (HTML §13.2.5), not JavaScript's wider `\s` (which
 * also matches, e.g., U+00A0, U+000B, U+2028, U+2029, U+3000, and U+FEFF).
 * Anything else ahead of the doctype — including a BOM that is not the very
 * first byte — is app content, not skippable whitespace, so the doctype is
 * not "leading" and the injected head goes first instead (`at = 0`); the
 * app's own doctype then simply lands in the body, which is harmless
 * (ruling P3-R22). A BOM as the very first character is likewise left as
 * content rather than stripped — also safe, since it then lands in the body
 * the same way.
 */
function afterDoctype(source: string): number {
  const match = /^[\t\n\f\r ]*<!doctype[^>]*>/i.exec(source);
  return match ? match[0].length : 0;
}

/**
 * The alphabet a nonce may use, and the length that makes it unguessable.
 * base64url only — no quote, backslash, `<`, or whitespace can appear in it —
 * which is what makes interpolating one straight into a script context below
 * safe without escaping. `newAppNonce` produces 22 characters from 16 random
 * bytes; the check is on the value rather than on its provenance, so a nonce
 * that came from anywhere else cannot escape the string it is written into.
 */
const NONCE_RE = /^[A-Za-z0-9_-]{16,}$/;

/**
 * A fresh handshake nonce for one mount of one app (ruling P4-R18). 16 random
 * bytes, base64url — enough that an app-authored script cannot guess the value
 * the SDK was handed, and it is deleted from the global before any app code
 * runs, so it cannot be read either.
 */
export function newAppNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Prepends the CSP, the handshake nonce, and the SDK to the app document so all
 * three are parsed before any app code: our `<head>` goes at the very top,
 * after nothing but a leading doctype (ruling P3-R16).
 *
 * This is the only ordering with no question attached, so it is the only one
 * used. Splicing into an app's own `<head>`/`<html>` needs the text before it
 * to be provably inert, and no regex can decide that: the tokenizer also ends
 * a comment at `--!>` and treats `<!-->` / `<!--->` as complete empty
 * comments, so a "comment" can hide a `<script>` that would then run — in the
 * implied head, before the policy — and a meta policy governs only what
 * follows it. Prepending costs nothing in return: after a doctype a `<head>`
 * start tag implies `<html>`, a later `<html>` start tag merges its attributes
 * into that element, and a later `<head>` start tag is ignored with its
 * children (`meta`, `title`, `link`, `style`, `script`, `base`) re-parented
 * into the head already open — so the app's own document survives intact,
 * inside our policy. A CSP `<meta>` can only tighten the policy, never loosen
 * it, so a policy the app ships of its own is no risk either.
 *
 * `sdkJs` is a parameter rather than a module import so this stays testable
 * without the built SDK bundle: `AppRunner` passes the text esbuild inlines
 * from `packages/kyoube-app-sdk/dist/kyoube-app-sdk.js`.
 *
 * `nonce` is written immediately ahead of the SDK, and nowhere else (ruling
 * P4-R18). Order is the whole point: the SDK script runs the instant it is
 * parsed, before any app-authored byte has been seen, so it reads the global
 * and deletes it while nothing else in the document has had a chance to run.
 * Every message the SDK then posts carries the nonce, and `handleAppMessage`
 * accepts none without it — so a document the frame navigates *itself* to
 * (which keeps the same WindowProxy, and so passes the bridge's source gate)
 * has nothing to send that the bridge will act on.
 *
 * **Placement contract** (ruling P4-R29): the nonce script is exactly the
 * element before the SDK script, and its text begins `window.__kyoubeNonce=`.
 * The SDK relies on both facts — `document.currentScript.previousElementSibling`
 * is how it finds the element, and the text prefix is how it checks it found the
 * right one — so that it can *remove* it. Deleting the global alone would leave
 * the value legible in the DOM, where any app script could read it back out of
 * `document.head`. Changing what goes between the meta and the SDK, or how the
 * nonce assignment is spelled, breaks that; `tests/unit/srcdoc.spec.ts` pins it,
 * and `scripts/browser-check.mjs` proves the removal in a real browser.
 */
export function buildSrcdoc(source: string, sdkJs: string, nonce: string): string {
  // The nonce goes into a JavaScript string literal, so it is checked rather
  // than escaped: nothing outside base64url can reach it, and a caller that
  // supplies anything else has a bug worth failing on rather than papering over.
  if (!NONCE_RE.test(nonce)) throw new Error("an app nonce must be at least 16 base64url characters");
  // `</script` anywhere in the SDK text would end the tag early and let the
  // rest of it be parsed as markup; the escape is invisible to JavaScript.
  const injection = `<meta http-equiv="Content-Security-Policy" content="${APP_CSP}"><script>window.__kyoubeNonce="${nonce}"</script><script>${sdkJs.replace(/<\/script/gi, "<\\/script")}</script>`;
  const at = afterDoctype(source);
  return `${source.slice(0, at)}<head>${injection}</head>${source.slice(at)}`;
}
