import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DecisionsSettingsView, type DecisionSettingsViewData } from "../../src/ui/DecisionsSettings.js";

const base: DecisionSettingsViewData = {
  settings: { agents: true, columns: false, apps: false, guardrail: false, dailyCap: 10000 },
  provider: { configured: true, provider: "openrouter", model: "typesafe/jev-1.13", keyResolves: true, problem: null },
  usage: { used: 37, cap: 10000 },
};

function render(view: DecisionSettingsViewData): string {
  return renderToStaticMarkup(createElement(DecisionsSettingsView, { view, onChange: () => {} }));
}

describe("DecisionsSettingsView", () => {
  it("shows provider, model, key state and today's usage", () => {
    const html = render(base);
    expect(html).toContain("Typed decisions");
    expect(html).toContain("openrouter");
    expect(html).toContain("typesafe/jev-1.13");
    expect(html).toContain("key resolves");
    expect(html).toContain("37 of 10000 requests used today (UTC)");
  });
  it("shows one switch per use and the egress warning", () => {
    const html = render(base);
    for (const label of ["Agents", "AI columns", "Kyoube Apps", "Guardrail on risky agent actions"]) expect(html).toContain(label);
    expect(html).toContain("data to the provider above");
    expect((html.match(/type="checkbox"/g) ?? []).length).toBe(4);
  });
  it("explains where to set a provider when none is configured, and shows a broken key", () => {
    expect(render({ ...base, provider: { configured: false, provider: null, model: null, keyResolves: false, problem: null } })).toContain("No provider is set for this company");
    expect(render({ ...base, provider: { ...base.provider, keyResolves: false, problem: "disabled: the typed-decisions API key could not be read" } })).toContain("the typed-decisions API key could not be read");
  });
});
