import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, MAX_UPLOAD_MB, resolveSettings } from "../src/settings.js";

describe("resolveSettings", () => {
  it("returns defaults for empty config", () => {
    expect(resolveSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(resolveSettings({})).toEqual(DEFAULT_SETTINGS);
  });
  it("accepts valid overrides and ignores invalid ones", () => {
    const settings = resolveSettings({ readRoles: ["Owner", 3, " admin "], writeRoles: [], maxEditableKb: 64, maxUploadMb: "9", maxDownloadMb: -1 });
    expect(settings).toEqual({ ...DEFAULT_SETTINGS, readRoles: ["owner", "admin"], maxEditableKb: 64 });
  });
  it("clamps the upload limit to what the core's JSON body limit can carry", () => {
    expect(resolveSettings({ maxUploadMb: 100 }).maxUploadMb).toBe(MAX_UPLOAD_MB);
    expect(resolveSettings({ maxUploadMb: 2 }).maxUploadMb).toBe(2);
  });
});
