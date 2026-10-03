import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWriteConfig } from "../src/commands/write-config.js";

afterEach(() => vi.restoreAllMocks());

describe("runWriteConfig", () => {
  it("still returns 0 and says so when the instance ID can't be created", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-wc-"));
    const home = path.join(dir, "home");
    const configPath = path.join(dir, "config.json");
    // <home>/kyoube is a regular file, so the instance ID file can't be created under it.
    await writeFile(home, "x").catch(() => {});
    const env = { KYOUBE_DATABASE_URL: "postgres://x", PAPERCLIP_HOME: home, HERMES_HOME: path.join(dir, "hermes"), KYOUBE_CONFIG_PATH: configPath };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await runWriteConfig(env)).toBe(0);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.startsWith("kyoube: could not create the instance ID (") && l.endsWith("instance-bound licence keys won't apply until it exists"))).toBe(true);
    expect(JSON.parse(await readFile(configPath, "utf8")).version).toBe(1);
  });
});
