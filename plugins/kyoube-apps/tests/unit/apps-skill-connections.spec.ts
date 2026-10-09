import { describe, expect, it } from "vitest";
import manifest, { APPS_SKILL_KEY, DATA_SKILL_KEY } from "../../src/manifest.js";

describe("kyoube-apps skill for connections", () => {
  const apps = manifest.skills!.find((skill) => skill.skillKey === APPS_SKILL_KEY)!.markdown;

  it("teaches discovery, direct calls, app calls, the publish rule and the limits", () => {
    for (const phrase of [
      "GET /connections", "POST /connections/{name}/call", "connections_list", "connections_call", "kyoube.connections.call",
      "connectionsConfirmed", "ctx.connections", "available", "$PAPERCLIP_API_KEY", "$PAPERCLIP_COMPANY_ID", "needs a person to publish",
      "2 MiB", "30 connection calls per 10 seconds", "25 seconds", "empty `body`", "least access",
    ]) {
      expect(apps).toContain(phrase);
    }
  });

  it("tells the agent what to ask a person for", () => {
    for (const phrase of ["Company, then Secrets", "Settings, then Plugins, then Kyoube Data & Apps", "Company Settings, then Data access, then Connections", "base URL", "header"]) {
      expect(apps).toContain(phrase);
    }
  });

  it("handles every error code an app can see", () => {
    for (const code of ["forbidden", "invalid", "disabled", "too_large", "timeout", "provider_unavailable", "limit"]) {
      expect(apps).toContain(`\`${code}\``);
    }
  });

  it("points the Data skill at connections", () => {
    const data = manifest.skills!.find((skill) => skill.skillKey === DATA_SKILL_KEY)!.markdown;
    expect(data).toContain("GET /connections");
    expect(data).toContain("kyoube-apps skill");
  });
});
