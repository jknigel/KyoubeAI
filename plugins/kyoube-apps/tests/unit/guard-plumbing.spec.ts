// tests/unit/guard-plumbing.spec.ts
import { describe, expect, it } from "vitest";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { handleApiRequest } from "../../src/api-routes.js";
import { handleAppsApiRequest } from "../../src/apps/api-routes.js";
import type { AppService } from "../../src/apps/service.js";
import { APP_TOOL_DEFINITIONS } from "../../src/apps/tools.js";
import { TOOL_DEFINITIONS } from "../../src/tools.js";
import { createStubService } from "../stub-service.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = { kind: "agent", id: "agent-1", runId: "run-1" };

function post(routeKey: string, path: string, params: Record<string, string>, body: Record<string, unknown>): PluginApiRequestInput {
  return { routeKey, method: "POST", path, params, query: {}, body: { companyId: COMPANY, ...body }, actor: { actorType: "agent", actorId: "agent-1", agentId: "agent-1", runId: "run-1" }, companyId: COMPANY, headers: {} };
}

describe("guard ids reach the services, and only as guard ids", () => {
  it("passes them on the five data routes", async () => {
    const { service, calls } = createStubService();
    await handleApiRequest(service, post("tables.drop", "/tables/t/drop", { table: "t" }, { issueId: "i-1" }));
    await handleApiRequest(service, post("fields.remove", "/tables/t/fields/f/remove", { table: "t", field: "f" }, { issueId: "i-1", confirmationId: "card-1" }));
    await handleApiRequest(service, post("tables.rename", "/tables/t/rename", { table: "t" }, { newName: "u", issueId: "i-1" }));
    await handleApiRequest(service, post("rows.update", "/tables/t/rows/update", { table: "t" }, { where: { field: "x", op: "eq", value: 1 }, patch: { y: 2 }, issueId: "i-1" }));
    await handleApiRequest(service, post("rows.delete", "/tables/t/rows/delete", { table: "t" }, { ids: ["a"], confirmationId: "card-1" }));
    expect(calls.map((call) => [call.method, call.args.at(-1)])).toEqual([
      ["dropTable", { issueId: "i-1" }],
      ["removeField", { issueId: "i-1", confirmationId: "card-1" }],
      ["renameTable", { issueId: "i-1" }],
      ["update", { issueId: "i-1" }],
      ["delete", { confirmationId: "card-1" }],
    ]);
    expect(calls[3]!.args.slice(3, 5)).toEqual([{ ids: undefined, where: { field: "x", op: "eq", value: 1 } }, { y: 2 }]);
    expect(calls[4]!.args[4]).toBeUndefined();
  });

  it("passes no guard when the call carries no guard ids", async () => {
    const { service, calls } = createStubService();
    await handleApiRequest(service, post("tables.drop", "/tables/t/drop", { table: "t" }, {}));
    await handleAppsApiRequest(service as unknown as AppService, post("apps.publish", "/apps/crm/publish", { slug: "crm" }, { version: 2 }));
    expect(calls[0]!.args[3]).toBeUndefined();
    expect(Object.keys(calls[1]!.args.at(-1) as object)).toEqual(["decisionsConfirmed"]);
  });

  it("refuses guard ids that are not strings", async () => {
    const { service, calls } = createStubService();
    const response = await handleApiRequest(service, post("tables.drop", "/tables/t/drop", { table: "t" }, { issueId: 7 }));
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("passes them on the three app routes", async () => {
    const { service, calls } = createStubService();
    const apps = service as unknown as AppService;
    await handleAppsApiRequest(apps, post("apps.publish", "/apps/crm/publish", { slug: "crm" }, { version: 2, issueId: "i-1" }));
    await handleAppsApiRequest(apps, post("apps.rollback", "/apps/crm/rollback", { slug: "crm" }, { version: 1, confirmationId: "card-1" }));
    await handleAppsApiRequest(apps, post("apps.archive", "/apps/crm/archive", { slug: "crm" }, { issueId: "i-1" }));
    expect(calls.map((call) => [call.method, (call.args.at(-1) as { guard?: unknown }).guard])).toEqual([
      ["publish", { issueId: "i-1" }],
      ["rollback", { confirmationId: "card-1" }],
      ["archive", { issueId: "i-1" }],
    ]);
  });

  it("passes them from the covered tools", async () => {
    const { service, calls } = createStubService();
    const tool = (name: string) => TOOL_DEFINITIONS.find((definition) => definition.name === name)!;
    const appTool = (name: string) => APP_TOOL_DEFINITIONS.find((definition) => definition.name === name)!;
    await tool("data_drop_table").run(service, COMPANY, AGENT as never, tool("data_drop_table").schema.parse({ table: "tickets", issueId: "i-1" }));
    await tool("data_delete").run(service, COMPANY, AGENT as never, tool("data_delete").schema.parse({ table: "tickets", where: { field: "x", op: "eq", value: 1 }, confirmationId: "card-1" }));
    await appTool("apps_archive").run(service as never, COMPANY, AGENT as never, appTool("apps_archive").schema.parse({ slug: "crm", issueId: "i-1" }));
    expect(calls.map((call) => call.args.at(-1))).toEqual([{ issueId: "i-1" }, { confirmationId: "card-1" }, { guard: { issueId: "i-1" } }]);
    for (const name of ["data_remove_field", "data_drop_table", "data_rename_table", "data_update", "data_delete"]) {
      expect(tool(name).description).toContain("issueId");
    }
    for (const name of ["apps_publish", "apps_rollback", "apps_archive"]) expect(appTool(name).description).toContain("issueId");
  });
});
