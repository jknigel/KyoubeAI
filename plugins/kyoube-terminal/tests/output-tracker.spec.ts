import { describe, expect, it } from "vitest";
import { createOutputTracker } from "../src/ui/output-tracker.js";

describe("createOutputTracker", () => {
  it("accepts strictly increasing sequence numbers once", () => {
    const tracker = createOutputTracker();
    expect(tracker.accept({ seq: 1 })).toBe(true);
    expect(tracker.accept({ seq: 2 })).toBe(true);
    expect(tracker.accept({ seq: 2 })).toBe(false);
    expect(tracker.accept({ seq: 1 })).toBe(false);
    expect(tracker.accept({ seq: 5 })).toBe(true);
    expect(tracker.lastSeq).toBe(5);
  });
  it("can be reset after a replay", () => {
    const tracker = createOutputTracker(10);
    expect(tracker.accept({ seq: 10 })).toBe(false);
    tracker.reset(3);
    expect(tracker.accept({ seq: 4 })).toBe(true);
  });
});
