import xtermCss from "@xterm/xterm/css/xterm.css";

let injected = false;

/**
 * Injects xterm's stylesheet once; plugin UI bundles cannot load external CSS files.
 *
 * The 8px inset belongs on the `.xterm` element, not on the host around it. The fit addon sizes
 * the rows from the host's computed height -- which, under the host UI's border-box preflight,
 * includes the host's own padding -- and subtracts only the `.xterm` element's padding. Padding on
 * the host is therefore space `fit()` hands to rows that do not have it: one row too many, which
 * enlarged the host (upstream's plugin page gives it no height of its own) and, through the page's
 * ResizeObserver, fitted it again -- the terminal grew by a row per layout pass. The check in
 * scripts/terminal-fit-check.mjs loads this stylesheet in a real browser and fails if fitting ever
 * changes the host's size.
 */
export function ensureXtermStyles(): void {
  if (injected || typeof document === "undefined") return;
  const style = document.createElement("style");
  style.setAttribute("data-kyoube-terminal", "");
  style.textContent = [
    xtermCss,
    ".kyoube-terminal-host { height: 100%; min-height: 480px; background: #0b0f14; border-radius: 6px; }",
    ".kyoube-terminal-host .xterm { padding: 8px; }",
  ].join("\n");
  document.head.appendChild(style);
  injected = true;
}
