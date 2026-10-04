import { describe, expect, it } from "vitest";
import manifest, { APPS_SKILL_KEY } from "../../src/manifest.js";

// The plugin version is pinned in one place only, tests/unit/plugin-decisions.spec.ts, so later
// milestones bump it there without touching this file.
describe("kyoube-apps skill for typed decisions", () => {
  it("teaches decision sets, the review lane, the person-only publish rule and fixtures", () => {
    const markdown = manifest.skills!.find((skill) => skill.skillKey === APPS_SKILL_KEY)!.markdown;
    for (const phrase of ['"decisions"', "kyoube.decide(", "kyoube.decideOutcome(", "ctx.decisions.available", "review", "needs a person to publish", "Compute dates", "fixture"]) {
      expect(markdown).toContain(phrase);
    }
  });
});
