// tests/integration/ai-column-schema.spec.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AiColumnHooks } from "../../src/data/ai-hooks.js";
import { DataError } from "../../src/data/errors.js";
import { DataService } from "../../src/data/service.js";
import { resetCompanyCache } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import { createTestDatabase } from "./setup.js";

const C = "77777777-7777-4777-8777-777777777777";
const OWNER = { kind: "user" as const, id: "owner-1" };
const refund = { type: "check", statement: "The ticket asks for a refund." };
const queue = { type: "choice", instructions: "Which team?", options: { billing: null, technical: null } };
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let service: DataService;
let enabled = true;
const changed: string[] = [];

const hooks: AiColumnHooks = {
  assertEnabled: async () => { if (!enabled) throw new DataError("disabled", "typed decisions for AI columns are switched off for this company"); },
  changed: (companyId) => void changed.push(companyId),
  rowsWritten: async () => {},
  counts: async () => ({}),
  listReview: async () => [],
  refill: async () => {},
  cells: async () => ({ provider: null, counts: {}, cells: {} }),
};

beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/ai-column-schema.spec.ts", "src/db/migrate.ts")));
  service = new DataService({ pool: db.pool, resolveUserRole: async (_c, userId) => (userId === "owner-1" ? "owner" : null) });
  await service.createTable(C, OWNER, { name: "contacts", fields: [{ name: "name", kind: "text" }] });
  await service.createTable(C, OWNER, { name: "tickets", fields: [
    { name: "subject", kind: "text" }, { name: "body", kind: "long_text" }, { name: "contact", kind: "relation", options: { relationTable: "contacts" } },
  ] });
});
afterAll(async () => { await db.close(); });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; return "resolved"; } catch (error) { return error instanceof DataError ? `${error.code}: ${error.message}` : String(error); }
}

describe("AI columns in the schema", () => {
  it("are refused while no AI-column hook is attached", async () => {
    expect(await codeOf(service.addField(C, OWNER, "tickets", { name: "refund", kind: "boolean", options: { decision: { question: refund, sourceFields: ["body"] } } }))).toMatch(/^disabled/);
  });

  it("need the AI columns use switched on", async () => {
    service.attach({ aiColumns: hooks });
    enabled = false;
    expect(await codeOf(service.addField(C, OWNER, "tickets", { name: "refund", kind: "boolean", options: { decision: { question: refund, sourceFields: ["body"] } } }))).toMatch(/^disabled/);
    enabled = true;
  });

  it("are created with derived choices and start a fill", async () => {
    const info = await service.addField(C, OWNER, "tickets", { name: "queue", kind: "select", options: { decision: { question: queue, sourceFields: ["subject", "body"] } } });
    expect(info.fields.find((field) => field.name === "queue")!.options).toMatchObject({ choices: ["billing", "technical"], decision: { sourceFields: ["subject", "body"] } });
    expect(changed).toEqual([C]);
    await expect(service.insert(C, OWNER, "tickets", [{ subject: "x", queue: "sales" }])).rejects.toThrow(/expects one of billing, technical/);
  });

  it("check their sources: fields of the same table, no relations, no other AI columns", async () => {
    const add = (sourceFields: string[], name = "refund") => service.addField(C, OWNER, "tickets", { name, kind: "boolean", options: { decision: { question: refund, sourceFields } } });
    expect(await codeOf(add(["nope"]))).toMatch(/reads "nope", which is not a field of "tickets"/);
    expect(await codeOf(add(["contact"]))).toMatch(/cannot read relation field "contact"/);
    expect(await codeOf(add(["queue"]))).toMatch(/cannot read AI column "queue"/);
    expect(await codeOf(add(["body"]))).toBe("resolved");
  });

  it("checks sources when a table is created with an AI column", async () => {
    const created = await service.createTable(C, OWNER, { name: "leads", fields: [
      { name: "note", kind: "text" },
      { name: "hot", kind: "boolean", options: { decision: { question: { type: "check", statement: "Ready to buy." }, sourceFields: ["note"] } } },
    ] });
    expect(created.fields.map((field) => field.name)).toEqual(["note", "hot"]);
    expect(await codeOf(service.createTable(C, OWNER, { name: "broken", fields: [
      { name: "hot", kind: "boolean", options: { decision: { question: { type: "check", statement: "Ready." }, sourceFields: ["missing"] } } },
    ] }))).toMatch(/^invalid/);
  });

  it("refuses to remove a field an AI column reads", async () => {
    expect(await codeOf(service.removeField(C, OWNER, "tickets", "body"))).toMatch(/field "body" feeds AI column "queue"/);
  });

  it("changes an AI column's question, replacing the choices constraint", async () => {
    const changedBefore = changed.length;
    const [kept, dropped] = await service.insert(C, OWNER, "tickets", [{ subject: "a", queue: "billing" }, { subject: "b", queue: "technical" }]);
    const next = { type: "choice", instructions: "Which team?", options: { billing: null, support: null } };
    const info = await service.updateField(C, OWNER, "tickets", "queue", { decision: { question: next, sourceFields: ["subject"] } });
    expect(info.fields.find((field) => field.name === "queue")!.options.choices).toEqual(["billing", "support"]);
    expect((await service.get(C, OWNER, "tickets", String(kept!.id)))!.queue).toBe("billing");
    expect((await service.get(C, OWNER, "tickets", String(dropped!.id)))!.queue).toBeNull();
    await expect(service.insert(C, OWNER, "tickets", [{ subject: "x", queue: "technical" }])).rejects.toThrow(/expects one of billing, support/);
    expect(changed.length).toBe(changedBefore + 1);
  });

  it("refuses hand-edited choices, required, a different kind, or a question on a plain field", async () => {
    expect(await codeOf(service.updateField(C, OWNER, "tickets", "queue", { choices: ["a", "b"] }))).toMatch(/come from its question/);
    expect(await codeOf(service.updateField(C, OWNER, "tickets", "queue", { required: true }))).toMatch(/cannot be required/);
    expect(await codeOf(service.updateField(C, OWNER, "tickets", "queue", { decision: { question: refund, sourceFields: ["subject"] } }))).toMatch(/kind must be boolean/);
    expect(await codeOf(service.updateField(C, OWNER, "tickets", "subject", { decision: { question: refund, sourceFields: ["body"] } }))).toMatch(/only an AI column has a question/);
  });
});
