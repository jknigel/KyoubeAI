import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, resolveSettings } from "../src/settings.js";

describe("resolveSettings", () => {
  it("returns defaults for empty config", () => {
    expect(resolveSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(resolveSettings({})).toEqual(DEFAULT_SETTINGS);
  });
  it("accepts valid overrides and ignores invalid ones", () => {
    const settings = resolveSettings({ idleTimeoutMinutes: 5, maxSessionsPerUser: "9", allowedRoles: ["owner"], shell: "/bin/sh", scrollbackKb: -1 });
    expect(settings).toEqual({ idleTimeoutMinutes: 5, maxSessionsPerUser: 3, allowedRoles: ["owner"], shell: "/bin/sh", scrollbackKb: 256 });
  });
  it("normalises allowedRoles to lowercase strings", () => {
    expect(resolveSettings({ allowedRoles: ["Owner", 3, " admin "] }).allowedRoles).toEqual(["owner", "admin"]);
  });
});
