/**
 * The plugin's own styles, injected once (the Studio pattern): the host's
 * compiled Tailwind only has the classes upstream uses, so new layout cannot
 * come from Tailwind classes. Colours read the core's and KyoubeAI's theme
 * tokens, each with a fallback.
 */
const CSS = String.raw`
.kn-card { display: flex; flex-direction: column; gap: 10px; }
.kn-card h3, .kn-section h3 { margin: 0; font-size: 14px; font-weight: 600; color: var(--foreground, #18181b); }
.kn-card p, .kn-section p { margin: 0; font-size: 13px; line-height: 1.45; color: var(--muted-foreground, #71717a); }
.kn-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.kn-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 16px; border-radius: 10px; border: 1px solid var(--border, #e4e4e7); background: var(--background, #fff); color: var(--foreground, #18181b); font-size: 13px; font-weight: 600; cursor: pointer; text-decoration: none; }
.kn-btn[data-primary] { background: var(--kyoube-accent, #0f766e); border-color: transparent; color: #fff; }
.kn-btn:disabled { opacity: .6; cursor: default; }
.kn-line { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 13px; color: var(--muted-foreground, #71717a); }
.kn-line a { color: var(--foreground, #18181b); text-decoration: underline; text-underline-offset: 3px; }
.kn-page { display: flex; flex-direction: column; gap: 16px; max-width: 640px; }
.kn-page h1 { margin: 0; font-size: 20px; font-weight: 600; }
.kn-section { display: flex; flex-direction: column; gap: 12px; padding: 16px; border: 1px solid var(--border, #e4e4e7); border-radius: 14px; }
.kn-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; color: var(--foreground, #18181b); }
.kn-row small { display: block; margin-top: 2px; font-size: 12px; color: var(--muted-foreground, #71717a); }
.kn-toggle { width: 22px; height: 22px; flex: none; accent-color: var(--kyoube-accent, #0f766e); }
.kn-error { color: var(--kyoube-danger, #dc2626) !important; }
/* The core wraps every dashboard widget in a bordered card: the one-line "on" state drops the frame, and the hidden states hide it. */
main div:has(> [data-kyoube-notify="line"]) { border: 0; padding: 0; background: none; box-shadow: none; }
main div:has(> [data-kyoube-notify="hidden"]) { display: none; }
`;

const STYLE_ID = "kyoube-notify-styles";

export function ensureStyles(doc: Document | undefined = typeof document === "undefined" ? undefined : document): void {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}
