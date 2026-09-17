import { describe, expect, it } from "vitest";
import { LEGACY_ENV_KEYS, exposureWarning, legacyEnvCheck, legacyHomeLinkCheck, skillsCheck } from "../src/commands/doctor.js";

const both = [{ slug: "kyoube-data", key: "plugin/kyoube-apps/kyoube-data", name: "Kyoube Data" }, { slug: "kyoube-apps", key: "plugin/kyoube-apps/kyoube-apps", name: "Kyoube Apps" }];

describe("skillsCheck", () => {
  it("passes when every company's library holds both Kyoube skills", () => {
    const check = skillsCheck([{ id: "c1", name: "Acme" }, { id: "c2", name: "Beta" }], new Map([["c1", both], ["c2", both]]));
    expect(check).toMatchObject({ name: "skills", ok: true });
    expect(check.detail).toContain("2/2 companies");
  });

  it("fails and names the companies that are missing a Kyoube skill", () => {
    const check = skillsCheck([{ id: "c1", name: "Acme" }, { id: "c2", name: "Beta" }], new Map([["c1", both], ["c2", [both[0]!]]]));
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("Beta");
    expect(check.detail).toContain("kyoube-apps");
    expect(check.detail).not.toContain("Acme");
  });

  it("passes with a note when there is no company yet", () => {
    const check = skillsCheck([], new Map());
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("no company");
  });

  it("recognises a skill by its library key when the slug was changed", () => {
    const renamed = both.map((skill) => ({ ...skill, slug: "renamed-by-admin" }));
    expect(skillsCheck([{ id: "c1", name: "Acme" }], new Map([["c1", renamed]])).ok).toBe(true);
  });
});

describe("exposureWarning", () => {
  it("only warns for public exposure without https", () => {
    expect(exposureWarning({}, "http://localhost:3100")).toBeNull();
    expect(exposureWarning({ PAPERCLIP_DEPLOYMENT_EXPOSURE: "public" }, "https://ai.example.com")).toBeNull();
    expect(exposureWarning({ PAPERCLIP_DEPLOYMENT_EXPOSURE: "public" }, "http://ai.example.com")).toContain("https");
  });

  it("treats an explicit private exposure the same as the default", () => {
    expect(exposureWarning({ PAPERCLIP_DEPLOYMENT_EXPOSURE: "private" }, "http://localhost:3100")).toBeNull();
  });

  it("names the offending public URL value in the warning", () => {
    const warning = exposureWarning({ PAPERCLIP_DEPLOYMENT_EXPOSURE: "public" }, "http://ai.example.com");
    expect(warning).toContain("http://ai.example.com");
  });
});

describe("legacyEnvCheck", () => {
  it("reports none when compose passed no legacy keys", () => {
    expect(legacyEnvCheck({})).toEqual({ name: "legacy env", ok: true, detail: "none" });
    expect(legacyEnvCheck({ KYOUBE_LEGACY_ENV_KEYS: "  " }).detail).toBe("none");
  });

  it("names each legacy key and its replacement", () => {
    const check = legacyEnvCheck({ KYOUBE_LEGACY_ENV_KEYS: "PAPERCLIP_PUBLIC_URL PAPERCLIP_VERSION" });
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("PAPERCLIP_PUBLIC_URL -> KYOUBE_PUBLIC_URL");
    expect(check.detail).toContain("PAPERCLIP_VERSION -> KYOUBE_CORE_VERSION");
    expect(check.detail).toContain("migrate-from-0.1.sh");
  });

  it("maps the three keys the compose file still accepts", () => {
    expect(LEGACY_ENV_KEYS).toEqual({
      PAPERCLIP_PUBLIC_URL: "KYOUBE_PUBLIC_URL",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "KYOUBE_DEPLOYMENT_EXPOSURE",
      PAPERCLIP_VERSION: "KYOUBE_CORE_VERSION",
    });
  });
});

describe("legacyHomeLinkCheck", () => {
  it("is quiet without the migration marker", async () => {
    expect(await legacyHomeLinkCheck("/kyoubeai", async () => false)).toEqual({ name: "legacy home link", ok: true, detail: "none" });
  });

  it("explains the compatibility link while the marker exists", async () => {
    const seen: string[] = [];
    const check = await legacyHomeLinkCheck("/kyoubeai", async (file) => { seen.push(file); return true; });
    expect(seen).toEqual(["/kyoubeai/.migrated-from-paperclip-home"]);
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("/paperclip -> /kyoubeai");
    expect(check.detail).toContain("--check");
  });
});
