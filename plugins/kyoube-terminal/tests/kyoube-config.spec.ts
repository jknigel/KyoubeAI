import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readKyoubeConfig } from "../src/kyoube-config.js";

describe("readKyoubeConfig", () => {
  it("reads the fields the plugin needs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-cfg-"));
    const file = path.join(dir, "config.json");
    await writeFile(file, JSON.stringify({ version: 1, home: "/kyoubeai", hermesHome: "/kyoubeai/.hermes", dataDatabaseUrl: "postgres://x", publicUrl: "http://localhost:3100", paperclipApiUrl: "http://127.0.0.1:3100", pluginRoot: "/opt/kyoube/plugins", imageVersion: "dev" }));
    expect(await readKyoubeConfig(file)).toEqual({ home: "/kyoubeai", hermesHome: "/kyoubeai/.hermes", dataDatabaseUrl: "postgres://x", publicUrl: "http://localhost:3100", paperclipApiUrl: "http://127.0.0.1:3100" });
  });

  it("fails loudly when a field is missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-cfg-"));
    const file = path.join(dir, "config.json");
    await writeFile(file, JSON.stringify({ version: 1, home: "/kyoubeai" }));
    await expect(readKyoubeConfig(file)).rejects.toThrow("hermesHome");
  });

  it("names the file when the config is not valid JSON", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-cfg-"));
    const file = path.join(dir, "config.json");
    await writeFile(file, "{ \"home\": /kyoubeai }");
    // A bare SyntaxError would not say which file the worker failed to read.
    await expect(readKyoubeConfig(file)).rejects.toThrow(file);
    await expect(readKyoubeConfig(file)).rejects.toThrow("not valid JSON");
  });

  it("names the file when the config is not a JSON object", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-cfg-"));
    const file = path.join(dir, "config.json");
    await writeFile(file, "[]");
    await expect(readKyoubeConfig(file)).rejects.toThrow(`kyoube config ${file} is not a JSON object`);
  });
});
