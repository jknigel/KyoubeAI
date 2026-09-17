import { describe, expect, it } from "vitest";
import { APP_OWN_HEAD, DOCUMENT_SHAPES, EARLY_CLOSED_COMMENTS, LEADING_DOCTYPE, UNICODE_WHITESPACE, type SrcdocCase } from "../fixtures/srcdoc-cases.js";
import { APP_CSP, buildSrcdoc, newAppNonce } from "../../src/ui/apps/srcdoc.js";

// The document shapes live in tests/fixtures/srcdoc-cases.ts: scripts/browser-check.mjs
// runs every one of them through a real headless Chrome (ruling P4-R22), and
// the two must cover exactly the same set.
const SDK = "window.kyoube=1";
const NONCE = "TESTnonce_0123456789-x";
const HEAD = '<head><meta http-equiv="Content-Security-Policy"';

/**
 * The property ruling P3-R16 turns on: whatever the app ships, our policy and
 * the SDK are parsed before any of it. `buildSrcdoc` moves nothing but a
 * leading doctype, so the app's own bytes come back verbatim *after* our head
 * — which this checks by reassembling the source from the two pieces around
 * the injection.
 */
function expectPolicyFirst(source: string): string {
  const html = buildSrcdoc(source, SDK, NONCE);
  const headAt = html.indexOf(HEAD);
  const appAt = html.indexOf("</head>") + "</head>".length;
  expect(headAt).toBeGreaterThanOrEqual(0);
  expect(html.indexOf(APP_CSP)).toBeLessThan(appAt);
  expect(html.indexOf(`<script>${SDK}</script>`)).toBeLessThan(appAt);
  // Only the app's own leading doctype may precede our head — and only when
  // introduced by HTML ASCII whitespace (`[\t\n\f\r ]`), the tokenizer's own
  // whitespace class, not JavaScript's wider `\s` (ruling P3-R22).
  expect(html.slice(0, headAt)).toMatch(/^([\t\n\f\r ]*<!doctype[^>]*>)?$/i);
  // ...and everything else is the app's source, unmoved and unedited.
  expect(html.slice(0, headAt) + html.slice(appAt)).toBe(source);
  return html;
}

describe("buildSrcdoc", () => {
  it("prepends the policy and the SDK to every document shape", () => {
    for (const shape of DOCUMENT_SHAPES) expectPolicyFirst(shape.source);
    expect(buildSrcdoc("<html><body>hi</body></html>", SDK, NONCE).startsWith(HEAD)).toBe(true);
  });

  it("keeps a leading doctype, and only a leading doctype, ahead of the head it creates", () => {
    for (const shape of LEADING_DOCTYPE) expect(expectPolicyFirst(shape.source).startsWith(shape.prefix!), shape.name).toBe(true);
  });

  it("treats Unicode whitespace before the doctype as app content, not an inert prefix (ruling P3-R22)", () => {
    for (const shape of UNICODE_WHITESPACE) expect(expectPolicyFirst(shape.source).startsWith(HEAD), shape.name).toBe(true);
  });

  it("puts the policy ahead of app code hidden behind a comment the tokenizer ends early", () => {
    for (const shape of EARLY_CLOSED_COMMENTS) {
      const html = expectPolicyFirst(shape.source);
      expect(html.indexOf(APP_CSP), shape.name).toBeLessThan(html.indexOf("<script>fetch"));
    }
  });

  it("leaves an app's own head, header, and custom elements after ours", () => {
    for (const shape of APP_OWN_HEAD) {
      const html = expectPolicyFirst(shape.source);
      expect(html.indexOf(APP_CSP), shape.name).toBeLessThan(html.toLowerCase().indexOf(shape.source.slice(0, 8).toLowerCase()));
    }
  });

  // The browser check reads the same fixtures by name; a duplicate name there
  // would silently shadow a shape rather than run it.
  it("names every shape the browser check runs exactly once", () => {
    const groups: SrcdocCase[][] = [DOCUMENT_SHAPES, LEADING_DOCTYPE, UNICODE_WHITESPACE, EARLY_CLOSED_COMMENTS, APP_OWN_HEAD];
    const cases = groups.flat();
    expect(new Set(cases.map((shape) => shape.name)).size).toBe(cases.length);
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });


  it("uses a CSP that blocks network and remote scripts", () => {
    expect(APP_CSP).toContain("default-src 'none'");
    expect(APP_CSP).toContain("connect-src 'none'");
    expect(APP_CSP).not.toContain("https:");
    expect(APP_CSP).not.toContain("unsafe-eval");
  });

  it("neutralises a closing script tag inside the SDK text", () => {
    const html = buildSrcdoc("<html><body></body></html>", "var a = '</script><img src=x>';", NONCE);
    expect(html).not.toContain("'</script>");
    expect(html).toContain("'<\\/script><img src=x>';</script>");
  });
});

// Ruling P4-R18: the handshake nonce is written into the head the runner
// prepends, immediately ahead of the SDK — so the SDK reads (and deletes) it
// before a single byte of app-authored markup has been parsed, and the policy
// still governs everything, the nonce script included.
describe("buildSrcdoc nonce", () => {
  it("inlines the nonce after the policy and immediately before the SDK", () => {
    const html = expectPolicyFirst("<!doctype html><html><body>hi</body></html>");
    const cspAt = html.indexOf(APP_CSP);
    const nonceAt = html.indexOf(`<script>window.__kyoubeNonce="${NONCE}"</script>`);
    const sdkAt = html.indexOf(`<script>${SDK}</script>`);
    expect(cspAt).toBeGreaterThanOrEqual(0);
    expect(nonceAt).toBeGreaterThan(cspAt);
    expect(sdkAt).toBe(nonceAt + `<script>window.__kyoubeNonce="${NONCE}"</script>`.length);
    // Both scripts are inside the head we opened, ahead of everything the app ships.
    expect(sdkAt).toBeLessThan(html.indexOf("</head>"));
  });

  // Ruling P4-R29: the SDK finds the nonce script as
  // `document.currentScript.previousElementSibling` and checks its text before
  // removing it, so that the value is not left legible in the DOM after the
  // global is deleted. Both halves of that contract are pinned here: exactly one
  // element between the policy and the SDK, and its text starting with the
  // assignment the SDK looks for.
  it("keeps the placement contract the SDK removes the nonce script by", () => {
    for (const shape of ["<!doctype html><html><body>hi</body></html>", "<header>hi</header>", ""]) {
      const html = buildSrcdoc(shape, SDK, NONCE);
      const head = html.slice(html.indexOf("<head>") + "<head>".length, html.indexOf("</head>"));
      const elements = head.match(/<(meta|script)\b[^>]*>/g) ?? [];
      expect(elements.map((tag) => tag.slice(1).split(/[\s>]/)[0]), shape).toEqual(["meta", "script", "script"]);
      // The SDK matches on this exact prefix (`indexOf(...) === 0`), so the
      // assignment must stay spelled this way and stay first in the script.
      const nonceScript = head.slice(head.indexOf("<script>") + "<script>".length);
      expect(nonceScript.startsWith(`window.__kyoubeNonce="`), shape).toBe(true);
    }
  });

  it("refuses a nonce that is not at least 16 base64url characters", () => {
    // The nonce is interpolated into a script context, so nothing but the
    // base64url alphabet may reach it: a quote, a backslash, or a `</script`
    // would end the string (or the tag) and turn the injection into app code.
    for (const bad of ["", "short", `x";alert(1);//`, "has spaces in it here", "back\\slash-padding-x", "</script>aaaaaaaaaaaa"]) {
      expect(() => buildSrcdoc("<html></html>", SDK, bad), bad).toThrow(/nonce/);
    }
  });
});

describe("newAppNonce", () => {
  it("makes a fresh base64url nonce of at least 16 characters every time", () => {
    const nonces = Array.from({ length: 64 }, () => newAppNonce());
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[A-Za-z0-9_-]{16,}$/);
      expect(() => buildSrcdoc("<html></html>", SDK, nonce)).not.toThrow();
    }
    // 16 random bytes: a repeat inside one small sample would mean the source
    // is not random at all (a fixed or counter-based value, say).
    expect(new Set(nonces).size).toBe(nonces.length);
  });
});
