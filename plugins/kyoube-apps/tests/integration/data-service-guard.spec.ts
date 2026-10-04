// tests/integration/data-service-guard.spec.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DataError } from "../../src/data/errors.js";
import { DataService } from "../../src/data/service.js";
import { resetCompanyCache } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import type { GuardedAction } from "../../src/decisions/guardrail.js";
import { Guardrail } from "../../src/decisions/guardrail-service.js";
import { createTestDatabase } from "./setup.js";

const C = "12121212-1212-4121-8121-121212121212";
const OWNER = { kind: "user" as const, id: "owner-1" };
const AGENT = { kind: "agent" as const, id: "agent-1", runId: "run-1" };
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let service: DataService;
const seen: GuardedAction[] = [];
let refuse = false;
let ids: string[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/data-service-guard.spec.ts", "src/db/migrate.ts")));
  service = new DataService({ pool: db.pool, resolveUserRole: async (_c, userId) => (userId === "owner-1" ? "owner" : null) });
  service.attach({
    guardAgentAction: async (action) => {
      seen.push(action);
      if (refuse) throw new DataError("held", "wait for the person", { details: { confirmationId: "card-1" } });
    },
  });
  await service.createTable(C, OWNER, { name: "tickets", fields: [{ name: "subject", kind: "text" }, { name: "stage", kind: "text" }] });
  const rows = await service.insert(C, OWNER, "tickets", Array.from({ length: 30 }, (_, i) => ({ subject: `t${i}`, stage: i < 12 ? "old" : "new" })));
  ids = rows.map((row) => String(row.id));
  await service.setAgentGrant(C, OWNER, "agent-1", "schema");
});
afterAll(async () => { await db.close(); });
beforeEach(() => { seen.length = 0; refuse = false; });

describe("the guard hook in DataService", () => {
  it("checks an agent's drop after authorisation, counts the rows, and keeps the table when held", async () => {
    refuse = true;
    const error = await service.dropTable(C, AGENT, "tickets", { issueId: "issue-1" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "held", details: { confirmationId: "card-1" } });
    expect(seen[0]).toMatchObject({ companyId: C, actor: AGENT, operation: "drop_table", table: "tickets", params: { table: "tickets" }, guard: { issueId: "issue-1" } });
    expect(await seen[0]!.countRows!()).toBe(30);
    expect((await service.describeTable(C, OWNER, "tickets")).name).toBe("tickets");
  });

  it("does not check people, or agents the call would refuse anyway", async () => {
    await service.createTable(C, OWNER, { name: "scratch", fields: [] });
    await service.renameTable(C, OWNER, "scratch", "scratch_2");
    expect(seen).toHaveLength(0);
    await service.setAgentGrant(C, OWNER, "agent-1", "write");
    await expect(service.dropTable(C, AGENT, "scratch_2", { issueId: "issue-1" })).rejects.toThrow("forbidden");
    expect(seen).toHaveLength(0);
    await service.setAgentGrant(C, OWNER, "agent-1", "schema");
  });

  it("checks bulk row changes, not small ones", async () => {
    await service.delete(C, AGENT, "tickets", { ids: ids.slice(0, 3) });
    expect(seen).toHaveLength(0);
    refuse = true;
    await expect(service.delete(C, AGENT, "tickets", { where: { field: "stage", op: "eq", value: "old" } }, undefined, { issueId: "issue-1" })).rejects.toThrow("held");
    expect(seen[0]).toMatchObject({ operation: "delete", table: "tickets", params: { table: "tickets", ids: null, where: { field: "stage", op: "eq", value: "old" } } });
    expect(await seen[0]!.countRows!()).toBe(9);
    const many = [...ids.slice(5, 26), ids[5]!];
    await expect(service.update(C, AGENT, "tickets", { ids: many }, { stage: "closed" }, undefined, { issueId: "issue-1" })).rejects.toThrow("held");
    expect(seen[1]).toMatchObject({ operation: "update", params: { table: "tickets", ids: [...new Set(many)].sort(), where: null, patch: { stage: "closed" } } });
    expect(await seen[1]!.countRows!()).toBe(21);
    expect((await service.count(C, OWNER, "tickets", { field: "stage", op: "eq", value: "closed" }))).toBe(0);
  });

  it("checks removing a field and renaming a table", async () => {
    refuse = true;
    await expect(service.removeField(C, AGENT, "tickets", "stage", { issueId: "issue-1" })).rejects.toThrow("held");
    await expect(service.renameTable(C, AGENT, "tickets", "old_tickets", { issueId: "issue-1" })).rejects.toThrow("held");
    expect(seen.map((action) => [action.operation, action.field ?? action.newName])).toEqual([["remove_field", "stage"], ["rename_table", "old_tickets"]]);
  });

  it("refuses a missing table or field with the same not_found as without the guardrail, before any check or card", async () => {
    const resolveUserRole = async (_c: string, userId: string) => (userId === "owner-1" ? "owner" : null);
    const decided: unknown[] = [];
    const cards: unknown[] = [];
    const guardrail = new Guardrail({
      pool: db.pool,
      decisions: {
        settingsFor: async () => ({ agents: false, columns: false, apps: false, guardrail: true, dailyCap: 100 }),
        decide: async (...args: unknown[]) => { decided.push(args); throw new DataError("provider_unavailable", "down"); },
      } as never,
      issues: {
        get: async (id, companyId) => ({ id, companyId, title: "Tidy the tickets", description: null, assigneeAgentId: "agent-1" }),
        requestConfirmation: async (_issueId, interaction) => { cards.push(interaction); return { id: `card-${cards.length}` }; },
        listInteractions: async () => [],
      },
    });
    const guarded = new DataService({ pool: db.pool, resolveUserRole });
    guarded.attach({ guardAgentAction: guardrail.check });
    const unguarded = new DataService({ pool: db.pool, resolveUserRole });
    const many = ids.slice(5, 26);
    const calls: Array<[string, (s: DataService) => Promise<unknown>]> = [
      ["drop a missing table", (s) => s.dropTable(C, AGENT, "nope", { issueId: "issue-1" })],
      ["rename a missing table", (s) => s.renameTable(C, AGENT, "nope", "still_nope", { issueId: "issue-1" })],
      ["remove a field of a missing table", (s) => s.removeField(C, AGENT, "nope", "stage", { issueId: "issue-1" })],
      ["remove a missing field", (s) => s.removeField(C, AGENT, "tickets", "nope", { issueId: "issue-1" })],
      ["bulk delete from a missing table", (s) => s.delete(C, AGENT, "nope", { where: { field: "stage", op: "eq", value: "old" } }, undefined, { issueId: "issue-1" })],
      ["bulk update a missing table by ids", (s) => s.update(C, AGENT, "nope", { ids: many }, { stage: "closed" }, undefined, { issueId: "issue-1" })],
      // Without issueId too: the missing target is reported, not the missing task.
      ["drop a missing table without issueId", (s) => s.dropTable(C, AGENT, "nope")],
    ];
    for (const [what, call] of calls) {
      const withGuardrail = await call(guarded).catch((error: unknown) => error);
      const without = await call(unguarded).catch((error: unknown) => error);
      expect(withGuardrail, what).toMatchObject({ code: "not_found" });
      expect((withGuardrail as DataError).message, what).toBe((without as DataError).message);
    }
    expect([decided.length, cards.length]).toEqual([0, 0]);
    // The table and its field are still there for an existing target, which goes on to the check.
    await expect(guarded.removeField(C, AGENT, "tickets", "stage", { issueId: "issue-1" })).rejects.toMatchObject({ code: "held" });
    expect([decided.length, cards.length]).toEqual([1, 1]);
  });

  it("goes ahead when the hook lets it", async () => {
    await service.createTable(C, OWNER, { name: "scratch_3", fields: [] });
    await service.dropTable(C, AGENT, "scratch_3", { issueId: "issue-1" });
    expect(seen.map((action) => action.operation)).toEqual(["drop_table"]);
    expect((await service.listTables(C, OWNER)).map((table) => table.name)).not.toContain("scratch_3");
  });
});
