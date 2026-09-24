import { describe, expect, it } from "vitest";
import { frameHeight, MIN_FRAME_HEIGHT, type FrameGeometry } from "../../src/ui/apps/frame-height.js";

/**
 * The geometry of the app frame on upstream's desktop layout at an 800px-tall
 * window: a 57px header above `main` (`overflow-auto`, 24px padding), then the
 * Runner's own 16px padding, a 28px toolbar and an 8px gap before the frame.
 * Below the frame only the Runner's 16px bottom padding stands between it and
 * `main`'s content box, which ends 24px above `main`'s bottom edge.
 *
 *   main content box: 57 + 24 = 81 … 800 - 24 = 776
 *   frame top:        81 + 16 + 28 + 8 = 133
 *   room:             776 - 16 - 133 = 627
 */
const desktop: FrameGeometry = {
  containerTop: 57,
  containerBorderTop: 0,
  containerClientHeight: 743,
  containerPaddingBottom: 24,
  containerScrollTop: 0,
  frameTop: 133,
  spaceBelow: 16,
};

describe("frameHeight", () => {
  it("fills exactly the room left under the frame in its scroll container", () => {
    expect(frameHeight(desktop)).toBe(627);
  });

  it("is unaffected by how far the container is already scrolled", () => {
    // Scrolling `main` 100px moves the frame 100px up the viewport; the room
    // inside the container is the same.
    expect(frameHeight({ ...desktop, containerScrollTop: 100, frameTop: 33 })).toBe(627);
  });

  it("measures from inside the container's top border", () => {
    // A 2px border pushes the frame 2px down the viewport without changing the
    // container's client box; `clientTop` says so.
    expect(frameHeight({ ...desktop, containerBorderTop: 2, frameTop: 135 })).toBe(627);
  });

  it("never hands the browser a fraction of a pixel", () => {
    // Fractional layout rounds the other way in `scrollHeight`; a 627.6px
    // frame would overflow by a pixel and show a scrollbar for it.
    expect(frameHeight({ ...desktop, containerClientHeight: 743.6 })).toBe(627);
    expect(Number.isInteger(frameHeight({ ...desktop, frameTop: 133.3, spaceBelow: 16.4 }))).toBe(true);
  });

  it("stops shrinking at the minimum and lets the page scroll instead", () => {
    // A 300px-tall container cannot hold the toolbar and a usable app; the
    // frame keeps its floor and `main` scrolls, which is the lesser evil.
    expect(frameHeight({ ...desktop, containerClientHeight: 300 })).toBe(MIN_FRAME_HEIGHT);
    expect(MIN_FRAME_HEIGHT).toBeGreaterThan(150); // the browser's default iframe height — what "tiny" was
  });

  it("takes a custom minimum", () => {
    expect(frameHeight({ ...desktop, containerClientHeight: 300 }, 100)).toBe(184);
  });
});
