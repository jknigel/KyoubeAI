import { describe, expect, it } from "vitest";
import { ICON_TRAITS, characterFor, nameHash } from "../src/characters.js";

// The core's agent icon picker (ui/src/lib/agent-icons.ts, core 2026.831.1).
const CORE_ICONS = ["bot", "cpu", "brain", "zap", "rocket", "code", "terminal", "shield", "eye", "search", "wrench", "hammer", "lightbulb", "sparkles", "star", "heart", "flame", "bug", "cog", "database", "globe", "lock", "mail", "message-square", "file-code", "git-branch", "package", "puzzle", "target", "wand", "atom", "circuit-board", "radar", "swords", "telescope", "microscope", "crown", "gem", "hexagon", "pentagon", "fingerprint"];

describe("characters", () => {
  it("draws a character for every icon the core lets you pick", () => {
    expect(CORE_ICONS.filter((icon) => !(icon in ICON_TRAITS))).toEqual([]);
  });

  it("is deterministic for the same icon and name", () => {
    expect(characterFor("rocket", "AI Delivery Lead")).toEqual(characterFor("rocket", "AI Delivery Lead"));
    expect(nameHash("AI Manager")).toBe(nameHash("AI Manager"));
  });

  it("lets the icon choose the tint and the name vary the face", () => {
    const a = characterFor("rocket", "AI Delivery Lead");
    const b = characterFor("rocket", "Marketing Manager");
    expect(a.tint).toBe("sky");
    expect(b.tint).toBe("sky");
    expect(a.svg).not.toBe(b.svg);
  });

  it("gives an agent with no icon (or an unknown one) a person picked by name", () => {
    const none = characterFor(null, "AI Manager");
    expect(none.svg).toContain("<ellipse");
    expect(characterFor("not-an-icon", "AI Manager")).toEqual(none);
  });

  it("draws robots for bot, cpu and circuit-board", () => {
    for (const icon of ["bot", "cpu", "circuit-board"]) expect(characterFor(icon, "x").svg).toContain('fill="#5eead4"');
  });

  it("produces a self-contained, decorative SVG", () => {
    for (const icon of CORE_ICONS) {
      const { svg } = characterFor(icon, "Sample");
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" aria-hidden="true"')).toBe(true);
      expect(svg.endsWith("</svg>")).toBe(true);
      expect(svg).not.toMatch(/<script|on[a-z]+=|href=/i);
      expect(svg).not.toContain("undefined");
    }
  });
});
