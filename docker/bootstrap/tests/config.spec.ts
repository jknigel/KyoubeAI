import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG_PATH,
  readConfig,
  renderConfigFromEnv,
  resolveConfigPath,
  writeConfig,
} from "../src/config.js";

describe("renderConfigFromEnv", () => {
  it("builds a config from the required and defaulted variables", () => {
    const config = renderConfigFromEnv({
      KYOUBE_DATABASE_URL: "postgres://kyoube:pw@db:5432/kyoube",
      PAPERCLIP_PUBLIC_URL: "http://localhost:3100",
      KYOUBE_VERSION: "1.2.3",
    });
    expect(config).toEqual({
      version: 1,
      dataDatabaseUrl: "postgres://kyoube:pw@db:5432/kyoube",
      home: "/kyoubeai",
      hermesHome: "/kyoubeai/.hermes",
      pluginRoot: "/opt/kyoube/plugins",
      paperclipApiUrl: "http://127.0.0.1:3100",
      publicUrl: "http://localhost:3100",
      imageVersion: "1.2.3",
    });
  });

  it("honours overrides for home, plugin root, api url, and hermes home", () => {
    const config = renderConfigFromEnv({
      KYOUBE_DATABASE_URL: "postgres://x",
      PAPERCLIP_HOME: "/data/pc",
      KYOUBE_PLUGIN_ROOT: "/plugins",
      PAPERCLIP_API_URL: "http://app:3100/",
      HERMES_HOME: "/data/pc/hermes",
    });
    expect(config.home).toBe("/data/pc");
    expect(config.pluginRoot).toBe("/plugins");
    expect(config.paperclipApiUrl).toBe("http://app:3100");
    expect(config.hermesHome).toBe("/data/pc/hermes");
    expect(config.publicUrl).toBe("http://127.0.0.1:3100");
    expect(config.imageVersion).toBe("dev");
  });

  it("throws when KYOUBE_DATABASE_URL is missing", () => {
    expect(() => renderConfigFromEnv({})).toThrow("KYOUBE_DATABASE_URL is required");
  });
});

describe("resolveConfigPath", () => {
  it("defaults to the container path and honours KYOUBE_CONFIG_PATH", () => {
    expect(resolveConfigPath({})).toBe(DEFAULT_CONFIG_PATH);
    expect(resolveConfigPath({ KYOUBE_CONFIG_PATH: "/tmp/k.json" })).toBe("/tmp/k.json");
  });
});

describe("writeConfig / readConfig", () => {
  it("round-trips through disk, creating parent directories", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-config-"));
    const filePath = path.join(dir, "nested", "config.json");
    const config = renderConfigFromEnv({ KYOUBE_DATABASE_URL: "postgres://x" });
    await writeConfig(filePath, config);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(config);
    expect(await readConfig(filePath)).toEqual(config);
    if (process.platform !== "win32") {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects a file that is not a version-1 config", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-config-"));
    const filePath = path.join(dir, "bad.json");
    await writeConfig(filePath, { version: 1, dataDatabaseUrl: "" } as never);
    await expect(readConfig(filePath)).rejects.toThrow("dataDatabaseUrl");
  });
});
