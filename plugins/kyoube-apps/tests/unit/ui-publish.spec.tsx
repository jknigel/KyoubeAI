// tests/unit/ui-publish.spec.tsx
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { providerName, PublishDisclosure, sentFields, type PublishPreviewData } from "../../src/ui/apps/PublishDisclosure.js";

const preview: PublishPreviewData = {
  version: 3, changed: true, provider: "openrouter", available: true,
  sets: [{ key: "triage", table: "tickets", fields: ["subject", "body"], advisory: false, questions: [
    { key: "queue", type: "choice", text: "Which team owns this ticket?" },
    { key: "urgent", type: "check", text: "The ticket needs a reply today." },
  ] }],
};

function render(data: PublishPreviewData, confirmed = false): string {
  return renderToStaticMarkup(createElement(PublishDisclosure, { preview: data, appName: "Triage", confirmed, onConfirmedChange: () => {} }));
}

describe("PublishDisclosure", () => {
  it("says plainly what each set sends, to whom, and lists its questions", () => {
    const html = render(preview);
    expect(html).toContain("Sends <code>tickets.subject</code>, <code>tickets.body</code> to OpenRouter each time someone uses Triage.");
    expect(html).toContain("Which team owns this ticket?");
    expect(html).toContain("The ticket needs a reply today.");
  });
  it("asks for the confirmation only when the sets are new or changed", () => {
    expect(render(preview)).toContain("employment, credit, housing, health, education or legal status");
    expect((render(preview).match(/type="checkbox"/g) ?? []).length).toBe(1);
    expect(render({ ...preview, changed: false })).not.toContain('type="checkbox"');
  });
  it("marks advisory sets and warns when apps cannot use decisions yet", () => {
    expect(render({ ...preview, sets: [{ ...preview.sets[0]!, advisory: true }] })).toContain("advisory: every answer is only a suggestion");
    expect(render({ ...preview, available: false })).toContain("answer <code>disabled</code>");
  });
  it("names the providers", () => {
    expect(providerName("typesafe")).toBe("TypeSafe");
    expect(providerName("vercel")).toBe("Vercel AI Gateway");
    expect(providerName(null)).toBe("the company's decisions provider (none is set yet)");
    expect(sentFields(preview.sets[0]!)).toEqual(["tickets.subject", "tickets.body"]);
  });
});
