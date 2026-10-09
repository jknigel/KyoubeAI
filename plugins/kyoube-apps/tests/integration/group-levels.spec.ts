import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataService } from "../../src/data/service.js";
import { resetCompanyCache } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import type { GroupLevel } from "../../src/groups/levels.js";
import { createTestDatabase } from "./setup.js";

const C = "55555555-5555-4555-8555-555555555555";
const ROLES: Record<string, string> = { owner: "owner", admin: "admin", op: "operator", viewer: "viewer", lowered: "operator", multi: "viewer" };
const LEVELS: Record<string, GroupLevel[]> = { viewer: ["write"], lowered: ["read"], multi: ["read", "schema", "write"], owner: ["read"], gone: ["schema"] };
const user = (id: string) => ({ kind: "user" as const, id, runId: null });
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let data: DataService;

beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/group-levels.spec.ts", "src/db/migrate.ts")));
  data = new DataService({ pool: db.pool, resolveUserRole: async (_c, id) => ROLES[id] ?? null, groupLevels: async (_c, id) => LEVELS[id] ?? [] });
});
afterAll(async () => { await db.close(); });

describe("levelFor with groups", () => {
  it("uses the role when the person is in no levelled group", async () => {
    expect(await data.levelFor(C, user("op"))).toBe("write");
  });
  it("raises and lowers by the highest group level", async () => {
    expect(await data.levelFor(C, user("viewer"))).toBe("write");
    expect(await data.levelFor(C, user("lowered"))).toBe("read");
    expect(await data.levelFor(C, user("multi"))).toBe("schema");
  });
  it("never restricts owners and admins", async () => {
    expect(await data.levelFor(C, user("owner"))).toBe("schema");
    expect(await data.levelFor(C, user("admin"))).toBe("schema");
  });
  it("gives a person who left the company nothing, whatever their groups say", async () => {
    expect(await data.levelFor(C, user("gone"))).toBe("none");
  });
  it("keeps data-access administration with owners and admins", async () => {
    await expect(data.listAgentGrants(C, user("multi"))).rejects.toThrow("forbidden");
    await expect(data.listAgentGrants(C, user("admin"))).resolves.toEqual([]);
  });
});
