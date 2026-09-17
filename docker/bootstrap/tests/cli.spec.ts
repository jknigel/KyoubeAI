import { describe, expect, it } from "vitest";
import { main, parseArgs } from "../src/cli.js";

describe("parseArgs", () => {
  it("splits command, flags, and positionals", () => {
    expect(parseArgs(["ensure-plugins", "--watch", "--api-key", "k", "extra"])).toEqual({
      command: "ensure-plugins",
      flags: { watch: true, "api-key": "k" },
      positionals: ["extra"],
    });
    expect(parseArgs(["--help"])).toEqual({ command: null, flags: { help: true }, positionals: [] });
    expect(parseArgs(["setup", "--api-base=http://x:1"])).toEqual({ command: "setup", flags: { "api-base": "http://x:1" }, positionals: [] });
  });
});

describe("main", () => {
  it("prints usage and returns 0 for --help, 1 for unknown commands", async () => {
    const out: string[] = [];
    const original = console.log;
    console.log = (line?: unknown) => { out.push(String(line)); };
    try {
      expect(await main(["--help"])).toBe(0);
      expect(out.join("\n")).toContain("ensure-plugins");
      expect(await main(["nope"])).toBe(1);
    } finally {
      console.log = original;
    }
  });
});
