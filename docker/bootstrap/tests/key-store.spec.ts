import { mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readBoardKey, resolveBoardApiKey, resolveBoardKeyPath, writeBoardKey } from "../src/key-store.js";
import { renderConfigFromEnv } from "../src/config.js";

describe("key-store", () => {
  it("derives the key path from the config home", () => {
    const config = renderConfigFromEnv({ KYOUBE_DATABASE_URL: "postgres://x", PAPERCLIP_HOME: "/data" });
    expect(resolveBoardKeyPath(config)).toBe("/data/kyoube/board-key.json");
  });

  it("round-trips a key record and returns null when absent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-key-"));
    const filePath = path.join(dir, "board-key.json");
    expect(await readBoardKey(filePath)).toBeNull();
    await writeBoardKey(filePath, { token: "pcp_x", userId: "u1", createdAt: "2026-09-05T00:00:00.000Z" });
    expect(await readBoardKey(filePath)).toEqual({ token: "pcp_x", userId: "u1", createdAt: "2026-09-05T00:00:00.000Z" });
  });

  it("writes the key file owner-readable only", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-key-"));
    const filePath = path.join(dir, "board-key.json");
    await writeBoardKey(filePath, { token: "pcp_x", userId: "u1", createdAt: "2026-09-05T00:00:00.000Z" });
    if (process.platform !== "win32") {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("treats a malformed key file as missing and warns instead of throwing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-key-"));
    const filePath = path.join(dir, "board-key.json");
    await writeFile(filePath, '{"token": "pcp_trunc');
    const warnings: string[] = [];
    // `ensure-plugins --watch` re-reads this file every 60s; throwing here would
    // turn one corrupt file into a permanent crash loop.
    expect(await readBoardKey(filePath, (line) => warnings.push(line))).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("malformed");
    expect(await resolveBoardApiKey({}, filePath)).toBeNull();
  });

  it("prefers explicit, then env, then file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-key-"));
    const filePath = path.join(dir, "board-key.json");
    await writeBoardKey(filePath, { token: "from-file", userId: null, createdAt: "2026-09-05T00:00:00.000Z" });
    expect(await resolveBoardApiKey({ KYOUBE_BOARD_API_KEY: "from-env" }, filePath, "explicit")).toBe("explicit");
    expect(await resolveBoardApiKey({ KYOUBE_BOARD_API_KEY: "from-env" }, filePath)).toBe("from-env");
    expect(await resolveBoardApiKey({}, filePath)).toBe("from-file");
    expect(await resolveBoardApiKey({}, path.join(dir, "missing.json"))).toBeNull();
  });
});
