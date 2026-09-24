/**
 * Sizes the app frame to the room left under it, so the page around the app
 * never has to scroll.
 *
 * Why measurements rather than CSS: upstream's plugin page gives the frame
 * nothing to fill. `Layout.tsx` renders the page inside
 * `<main class="flex-1 p-4 md:p-6 overflow-auto">`, `PluginPage.tsx` wraps it in
 * `<div class="space-y-4"><div class="min-h-(--sz-200px)">`, and none of those
 * boxes has a definite height — so `height: 100%` on anything the plugin
 * renders resolves to `auto`, and `main` scrolls whenever the content is
 * taller than it. The plugin's UI bundle ships no stylesheet of its own
 * either: it borrows the host's compiled Tailwind, which contains only the
 * classes upstream's own sources use, so an arbitrary value like
 * `min-h-[600px]` matches no rule and is dropped without a word. Together
 * those left the frame at the browser's default 150px.
 *
 * So the frame is measured instead. Its height is the distance from its top
 * edge to the bottom of the scroll container's content box, less whatever
 * padding, borders and margins sit between the two — the exact amount that
 * leaves the container nothing to scroll. The container is the nearest
 * ancestor that scrolls vertically: upstream's `main` on desktop, and the
 * viewport on mobile, where `main` is `overflow-visible` and `body` scrolls.
 * Below `MIN_FRAME_HEIGHT` the frame stops shrinking and the container scrolls
 * after all: a squashed app is worse than a scrollbar.
 *
 * Nothing here knows upstream's class names or DOM shape; only that the frame
 * sits in some chain of boxes under something that scrolls (or the viewport).
 * `scripts/app-frame-check.mjs` lays these functions out in that chain in a
 * real browser and fails if the container ever has anything to scroll.
 */

/** Below this the frame holds its size and the page scrolls instead. */
export const MIN_FRAME_HEIGHT = 320;

/** Everything the frame's height is computed from, in CSS pixels. */
export interface FrameGeometry {
  /** Top edge of the scroll container's border box, in viewport coordinates (0 for the viewport itself). */
  containerTop: number;
  /** The container's top border width (`clientTop`), which its client box starts below. */
  containerBorderTop: number;
  /** The container's `clientHeight`: its padding box, less any horizontal scrollbar. */
  containerClientHeight: number;
  /** The container's bottom padding — its content box ends this far above its client box. */
  containerPaddingBottom: number;
  /** How far the container is scrolled (`scrollTop`; `scrollY` for the viewport). */
  containerScrollTop: number;
  /** Top edge of the frame's border box, in viewport coordinates. */
  frameTop: number;
  /** Bottom padding, border and margin of every box between the frame and the container's content box. */
  spaceBelow: number;
}

/**
 * The height that puts the frame's bottom edge, plus everything that follows
 * it, exactly on the container's content-box bottom — floored to whole pixels
 * (a fraction would round up in `scrollHeight` and show a scrollbar for it)
 * and never below `minHeight`.
 */
export function frameHeight(geometry: FrameGeometry, minHeight = MIN_FRAME_HEIGHT): number {
  // Where the frame's top sits within the container's client box, in the
  // container's own (scrolled) content coordinates.
  const offset = geometry.frameTop - geometry.containerTop - geometry.containerBorderTop + geometry.containerScrollTop;
  const room = geometry.containerClientHeight - geometry.containerPaddingBottom - offset - geometry.spaceBelow;
  return Math.max(minHeight, Math.floor(room));
}

/**
 * The nearest ancestor that scrolls vertically, or `null` when the page itself
 * does. `body` and `html` are never returned: overflow on them belongs to the
 * viewport, which is measured as such.
 */
export function scrollContainerOf(element: Element): HTMLElement | null {
  for (let node = element.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") return node;
  }
  return null;
}

const px = (value: string): number => parseFloat(value) || 0;

/** Bottom padding, border and margin of the frame and of every box from it up to (not including) the container. */
function spaceBelow(element: HTMLElement, container: HTMLElement | null): number {
  let total = px(getComputedStyle(element).marginBottom);
  const stop = container ?? document.documentElement;
  for (let node = element.parentElement; node && node !== stop; node = node.parentElement) {
    const style = getComputedStyle(node);
    total += px(style.paddingBottom) + px(style.borderBottomWidth) + px(style.marginBottom);
  }
  return total;
}

/** Reads the frame's geometry off the live layout. */
export function measureFrame(element: HTMLElement): FrameGeometry {
  const container = scrollContainerOf(element);
  const frameTop = element.getBoundingClientRect().top;
  if (!container) {
    return {
      containerTop: 0,
      containerBorderTop: 0,
      containerClientHeight: document.documentElement.clientHeight,
      containerPaddingBottom: 0,
      containerScrollTop: window.scrollY,
      frameTop,
      spaceBelow: spaceBelow(element, null),
    };
  }
  return {
    containerTop: container.getBoundingClientRect().top,
    containerBorderTop: container.clientTop,
    containerClientHeight: container.clientHeight,
    containerPaddingBottom: px(getComputedStyle(container).paddingBottom),
    containerScrollTop: container.scrollTop,
    frameTop,
    spaceBelow: spaceBelow(element, container),
  };
}

/**
 * Measures the frame and sets its height; returns the height set. The style is
 * written only when it changes, so a resize observer that fires because of
 * this very write sees nothing new and settles.
 */
export function fitFrame(element: HTMLElement, minHeight = MIN_FRAME_HEIGHT): number {
  const height = frameHeight(measureFrame(element), minHeight);
  const value = `${height}px`;
  if (element.style.height !== value) element.style.height = value;
  return height;
}

/**
 * Fits the frame now and again whenever anything that decides its room
 * changes: the window, the scroll container, or any box between the two (a
 * sibling above the frame appearing, growing or wrapping). Returns a disposer.
 *
 * Refits are deferred to a task of their own rather than done inside the
 * observer callback: a fit changes the height of the observed ancestors, and a
 * change made *during* delivery to an element no deeper than the one that
 * fired is what the browser reports as "ResizeObserver loop completed with
 * undelivered notifications". A task later, it is just another observation —
 * one that computes the same height and writes nothing. A zero timeout rather
 * than `requestAnimationFrame`: neither runs before the frame in which the
 * sibling grew is painted, and a timer also fires in a hidden tab and under
 * headless Chrome's virtual time, where animation frames may never come.
 */
export function keepFrameFitted(element: HTMLElement, minHeight = MIN_FRAME_HEIGHT): () => void {
  let pending = 0;
  const refit = () => {
    if (pending) return;
    pending = window.setTimeout(() => {
      pending = 0;
      fitFrame(element, minHeight);
    }, 0);
  };
  fitFrame(element, minHeight);
  window.addEventListener("resize", refit);
  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(refit);
    const container = scrollContainerOf(element);
    for (let node = element.parentElement; node; node = node.parentElement) {
      observer.observe(node);
      if (node === container || node === document.body) break;
    }
  }
  return () => {
    observer?.disconnect();
    window.removeEventListener("resize", refit);
    if (pending) window.clearTimeout(pending);
  };
}
