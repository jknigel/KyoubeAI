/**
 * The three text rules, applied in this order to every text file in the image:
 * exact phrase overrides (brand.json `phrases`), the URL map, then the generic
 * name rule. See the spec §B.2 for why the name rule is case-sensitive and
 * word-bounded: capitalised `Paperclip` is display text, everything else is an
 * identifier that upstream's own code compares against.
 */

/** Display-text form of the upstream name: not inside a camelCase identifier, not after a hyphen (headers), never lowercase. */
export const NAME_RE = /(?<![A-Za-z0-9_$-])Paperclip(?![A-Za-z0-9_$])/g;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function buildTextRules(brand) {
  const rules = [];
  for (const [from, to] of Object.entries(brand.phrases ?? {})) {
    rules.push({ kind: "phrase", from: new RegExp(escapeRegExp(from), "g"), to });
  }
  const { urls } = brand;
  // Longest / most specific first, so `paperclip.ing/feedback` never falls
  // through to the bare-host rule.
  rules.push(
    { kind: "url", from: /https:\/\/docs\.paperclip\.ing(?:\/[A-Za-z0-9./_#?=%-]*)?/g, to: urls.docs },
    { kind: "url", from: /https:\/\/paperclip\.ing\/feedback\b/g, to: urls.feedback },
    { kind: "url", from: /https:\/\/paperclip\.ing\/tos\b/g, to: urls.tos },
    { kind: "url", from: /https:\/\/paperclip\.ing\/ee\b/g, to: urls.home },
    { kind: "url", from: /https:\/\/github\.com\/paperclipai\/paperclip(?:\/[A-Za-z0-9./_#?=%-]*)?/g, to: urls.repo },
    { kind: "url", from: /https:\/\/paperclip\.ing(?=["'`)}\]\s,]|$)/g, to: urls.home },
  );
  rules.push({ kind: "name", from: NAME_RE, to: brand.name });
  return rules;
}

export function rewriteText(text, rules) {
  const counts = {};
  let out = text;
  for (const rule of rules) {
    let n = 0;
    out = out.replace(rule.from, () => { n += 1; return rule.to; });
    if (n > 0) counts[rule.kind] = (counts[rule.kind] ?? 0) + n;
  }
  return { text: out, counts };
}

/** Context (≤ 80 chars) around one match, whitespace-collapsed. */
function contextAt(text, index) {
  const start = Math.max(0, index - 35);
  return text.slice(start, start + 80).replace(/\s+/g, " ");
}

/** Contexts (≤ 80 chars) around what the name rule would still match — empty means clean. */
export function findResidual(text, max = 5) {
  const found = [];
  for (const match of text.matchAll(NAME_RE)) {
    found.push(contextAt(text, match.index));
    if (found.length >= max) break;
  }
  return found;
}

/**
 * Which characters of one line of source sit in *display* context — inside a
 * string literal, or inside a comment. `Paperclip` there is text a human reads;
 * anywhere else on the line it is an identifier the code depends on (a lucide
 * `import { Paperclip }`, a `<Paperclip .../>` element, `icon: Paperclip`).
 *
 * Deliberately per-line and deliberately conservative: a template literal that
 * opened on an *earlier* line leaves no quote before the match on this one, so
 * its continuation lines read as code and are reported rather than rewritten.
 * Widening that would mean tracking multi-line state, which is exactly where a
 * regex-shaped classifier starts rewriting identifiers.
 */
export function displayMask(line) {
  const mask = new Uint8Array(line.length);
  // A JSDoc/continuation line (` * …`) is comment text all the way across.
  if (/^\s*\*/.test(line)) { mask.fill(1); return mask; }
  let quote = null;
  let block = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    const next = line[i + 1];
    if (block) {
      mask[i] = 1;
      if (c === "*" && next === "/") { mask[i + 1] = 1; block = false; i += 1; }
      continue;
    }
    if (quote) {
      mask[i] = 1;
      if (c === "\\") { if (i + 1 < line.length) mask[i + 1] = 1; i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && next === "/") { mask.fill(1, i); return mask; }
    if (c === "/" && next === "*") { mask[i] = 1; mask[i + 1] = 1; block = true; i += 1; continue; }
    if (c === "'" || c === '"' || c === "`") { mask[i] = 1; quote = c; continue; }
  }
  return mask;
}

// Where a match that is *not* inside a string or comment is nevertheless a
// bare identifier rather than prose. The name appears in `packages/**` in two
// display shapes the quote/comment mask cannot see — the continuation lines of
// a multi-line template literal (every adapter's `docs` block) and JSX text —
// so classifying "outside a quote" as "identifier" would leave ~85 display
// strings unbranded. This is the complement: the three shapes the ruling named
// (`import { Paperclip }`, `<Paperclip`, `icon: Paperclip`) all put a symbol or
// a declaration keyword on *both* sides of the match, which prose never does.
const JSX_TAG_BEFORE = /<\/?$/;
const KEYWORD_BEFORE = /\b(?:import|export|type|interface|class|extends|implements|typeof|instanceof|declare|namespace|enum|satisfies)\s+$/;
const SYMBOL_BEFORE = /[{,(\[=:<>|&!?;+*]\s*$/;
const SYMBOL_AFTER = /^\s*[}\),\];:=<>|&?/]/;

/** Is the match at `index` a bare identifier reference (never rewritten)? */
export function identifierShaped(line, index, length) {
  const before = line.slice(0, index);
  const after = line.slice(index + length);
  if (JSX_TAG_BEFORE.test(before) || KEYWORD_BEFORE.test(before)) return true;
  const openBefore = SYMBOL_BEFORE.test(before) || before.trim() === "";
  const closeAfter = SYMBOL_AFTER.test(after) || after.trim() === "";
  return openBefore && closeAfter;
}

/** Indices on one line of code where the name rule applies (display text, not an identifier). */
export function displayMatches(line) {
  const mask = displayMask(line);
  const out = [];
  for (const match of line.matchAll(NAME_RE)) {
    if (mask[match.index] || !identifierShaped(line, match.index, match[0].length)) out.push(match.index);
  }
  return out;
}

/**
 * `rewriteText` for code files the server actually runs (`packages/**` `.ts`,
 * `.tsx`, `.js`, `.mjs`, `.cjs`): phrase and URL rules apply unconditionally —
 * they are exact strings no identifier collides with — while the generic name
 * rule is held back only where the match is *not* display text (no quote or
 * comment opened before it on its line) *and* is identifier-shaped. Everything
 * it declines to rewrite comes back as `codeShaped` contexts so the build can
 * print them rather than silently skip them.
 */
export function rewriteCode(text, rules) {
  const counts = {};
  const codeShaped = [];
  const nameRules = rules.filter((rule) => rule.kind === "name");
  const otherRules = rules.filter((rule) => rule.kind !== "name");
  const lines = text.split("\n").map((line) => {
    const phrased = rewriteText(line, otherRules);
    for (const [kind, n] of Object.entries(phrased.counts)) counts[kind] = (counts[kind] ?? 0) + n;
    let out = phrased.text;
    for (const rule of nameRules) {
      const mask = displayMask(out);
      let built = "";
      let last = 0;
      for (const match of out.matchAll(rule.from)) {
        const end = match.index + match[0].length;
        if (mask[match.index] || !identifierShaped(out, match.index, match[0].length)) {
          built += out.slice(last, match.index) + rule.to;
          counts[rule.kind] = (counts[rule.kind] ?? 0) + 1;
        } else {
          built += out.slice(last, end);
          codeShaped.push(contextAt(out, match.index));
        }
        last = end;
      }
      out = built + out.slice(last);
    }
    return out;
  });
  return { text: lines.join("\n"), counts, codeShaped };
}
