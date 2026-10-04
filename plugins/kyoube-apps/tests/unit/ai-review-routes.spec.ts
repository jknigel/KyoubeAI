// tests/unit/ai-review-routes.spec.ts
import { describe, expect, it } from "vitest";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { API_ROUTES, handleApiRequest } from "../../src/api-routes.js";
import { TOOL_DEFINITIONS } from "../../src/tools.js";
import { createStubService } from "../stub-service.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
function request(overrides: Partial<PluginApiRequestInput>): PluginApiRequestInput {
  return { routeKey: "tables.review", method: "GET", path: "/tables/tickets/review", params: { table: "tickets" }, query: {}, body: undefined, actor: { actorType: "agent", actorId: "agent-1", agentId: "agent-1" }, companyId: COMPANY, headers: {}, ...overrides };
}

describe("AI column routes and tool", () => {
  it("declares the review and refill routes", () => {
    expect(API_ROUTES.find((route) => route.routeKey === "tables.review")).toMatchObject({ method: "GET", path: "/tables/:table/review" });
    expect(API_ROUTES.find((route) => route.routeKey === "fields.refill")).toMatchObject({ method: "POST", path: "/tables/:table/fields/:field/refill" });
  });
  it("passes field, limit and offset to listReview", async () => {
    const stub = createStubService();
    await handleApiRequest(stub.service, request({ query: { field: "refund", limit: "20", offset: "40" } }));
    expect(stub.calls[0]).toMatchObject({ method: "listReview", args: [COMPANY, { kind: "agent", id: "agent-1" }, "tickets", { field: "refund", limit: 20, offset: 40 }] });
  });
  it("refills a column", async () => {
    const stub = createStubService();
    await handleApiRequest(stub.service, request({ routeKey: "fields.refill", method: "POST", path: "/tables/tickets/fields/refund/refill", params: { table: "tickets", field: "refund" }, body: { companyId: COMPANY } }));
    expect(stub.calls[0]).toMatchObject({ method: "refillAiColumn", args: [COMPANY, expect.anything(), "tickets", "refund"] });
  });
  it("offers data_list_review to agents", () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.name)).toContain("data_list_review");
  });
});
