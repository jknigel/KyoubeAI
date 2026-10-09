import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CALL_DEADLINE_MS, ConnectionService, SECRET_CALL_RETRY_MS, type CallVia, type ConnectionServiceDeps } from "../../src/connections/service.js";
import { DataError } from "../../src/data/errors.js";
import type { AccessLevel, DataActor } from "../../src/data/permissions.js";
import { actionFingerprint, type GuardedAction } from "../../src/decisions/guardrail.js";
import { SecretCache } from "../../src/secrets/cache.js";

const C = "11111111-1111-4111-8111-111111111111";
const SECRET = "sk_live_TOPSECRET";
const REF = { type: "secret_ref", secretId: "s-crm", version: "latest" };
const REF2 = { type: "secret_ref", secretId: "s-ro", version: "latest" };

const CRM = { name: "crm", baseUrl: "https://api.crm.example/v1/", auth: "bearer", secret: REF, methods: "read-write" };
const RO = { name: "ro", baseUrl: "https://api.ro.example/", auth: "header", headerName: "X-API-Key", secret: REF2, methods: "read" };

const VIEWER: DataActor = { kind: "user", id: "viewer", runId: null };
const MEMBER: DataActor = { kind: "user", id: "member", runId: null };
const OWNER: DataActor = { kind: "user", id: "owner", runId: null };
const STRANGER: DataActor = { kind: "user", id: "stranger", runId: null };
const AGENT: DataActor = { kind: "agent", id: "agent-1", runId: "run-1" };
const AGENT_RO: DataActor = { kind: "agent", id: "agent-ro", runId: "run-2" };
const AGENT_NONE: DataActor = { kind: "agent", id: "agent-none", runId: "run-3" };

const APP_READ: CallVia = { kind: "app", slug: "dash", version: 3, declared: "read" };
const APP_RW: CallVia = { kind: "app", slug: "dash", version: 3, declared: "read-write" };
const DIRECT: CallVia = { kind: "direct" };

const LEVELS: Record<string, AccessLevel> = { viewer: "read", member: "write", owner: "none", stranger: "none", "agent-1": "schema" };
const ROLES: Record<string, string> = { viewer: "viewer", member: "member", owner: "owner" };

interface Query { sql: string; params: unknown[] }

function fakePool(grants: Record<string, string>, auditFails: () => boolean = () => false) {
  const queries: Query[] = [];
  const audits: Array<{ operation: string; actorKind: string; actorId: string | null; runId: string | null; details: Record<string, unknown> }> = [];
  const respond = (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (sql.startsWith("SELECT access FROM kyoube_meta.connection_grants")) {
      const access = grants[`${params[1]}/${params[2]}`];
      return { rows: access ? [{ access }] : [] };
    }
    if (sql.startsWith("SELECT agent_id, connection_name")) {
      return {
        rows: Object.entries(grants).map(([key, access]) => {
          const [agent_id, connection_name] = key.split("/");
          return { agent_id, connection_name, access, updated_by: null, updated_at: new Date(0) };
        }),
      };
    }
    if (sql.startsWith("INSERT INTO kyoube_meta.audit")) {
      if (auditFails()) throw new Error("audit insert refused");
      audits.push({ operation: params[4] as string, actorKind: params[1] as string, actorId: params[2] as string | null, runId: params[3] as string | null, details: params[6] as Record<string, unknown> });
    }
    return { rows: [] };
  };
  const pool = {
    query: async (sql: string, params?: unknown[]) => respond(sql, params),
    connect: async () => ({ query: async (sql: string, params?: unknown[]) => respond(sql, params), release: () => {} }),
  };
  return { pool: pool as unknown as Pool, queries, audits };
}

interface Options {
  config?: Record<string, unknown>;
  grants?: Record<string, string>;
  resolve?: (binding: unknown, companyId: string, configPath: string) => Promise<string>;
  respond?: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Response>;
  guard?: boolean;
  auditFails?: () => boolean;
}

function setup(opts: Options = {}) {
  const clock = { t: 1_000_000 };
  let config = opts.config ?? { connections: [CRM, RO] };
  const grants = opts.grants ?? { "agent-1/crm": "read-write", "agent-1/ro": "read-write", "agent-ro/crm": "read" };
  const { pool, queries, audits } = fakePool(grants, opts.auditFails);
  const logs: Array<{ message: string; meta: Record<string, unknown> }> = [];
  const resolves: Array<{ binding: unknown; configPath: string }> = [];
  const resolve = opts.resolve ?? (async () => SECRET);
  const secrets = new SecretCache({
    resolve: (binding, companyId, configPath) => { resolves.push({ binding, configPath }); return resolve(binding, companyId, configPath); },
    now: () => clock.t,
  });
  const fetches: Array<{ url: string; init: { method: string; headers: Record<string, string>; body?: string } }> = [];
  const respond = opts.respond ?? (async () => new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }));
  const guardCalls: GuardedAction[] = [];
  const activity: Array<{ companyId: string; actor: DataActor; summary: string }> = [];
  const deps: ConnectionServiceDeps = {
    pool,
    getConfig: async () => config,
    secrets,
    fetch: async (url, init) => { fetches.push({ url, init }); return respond(url, init); },
    levelFor: async (_companyId, actor) => LEVELS[actor.id ?? ""] ?? "none",
    resolveUserRole: async (_companyId, userId) => ROLES[userId] ?? null,
    onActivity: async (event) => { activity.push(event); },
    log: (message, meta) => { logs.push({ message, meta }); },
    now: () => clock.t,
  };
  if (opts.guard !== false) deps.guardAgentAction = async (action) => { guardCalls.push(action); };
  const service = new ConnectionService(deps);
  return {
    service, deps, clock, queries, audits, logs, resolves, fetches, guardCalls, activity,
    setConfig: (next: Record<string, unknown>) => { config = next; },
  };
}

async function refusal(promise: Promise<unknown>): Promise<DataError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DataError);
    return error as DataError;
  }
  throw new Error("expected a refusal");
}

const GET = { method: "GET", path: "contacts" };
const POST = { method: "POST", path: "contacts", body: { name: "Ada" } };

describe("ConnectionService.call: authorisation", () => {
  describe("from an app", () => {
    it("lets a viewer with read GET through a read declaration", async () => {
      const t = setup();
      expect((await t.service.call(C, VIEWER, "crm", GET, APP_READ)).status).toBe(200);
    });

    it("refuses a person with no level", async () => {
      const t = setup();
      expect((await refusal(t.service.call(C, STRANGER, "crm", GET, APP_READ))).code).toBe("forbidden");
      expect(t.fetches).toHaveLength(0);
    });

    it("refuses a write by a read-level viewer even through a read-write declaration", async () => {
      const t = setup();
      expect((await refusal(t.service.call(C, VIEWER, "crm", POST, APP_RW))).code).toBe("forbidden");
    });

    it("refuses a write when the app declared read only", async () => {
      const t = setup();
      expect((await refusal(t.service.call(C, MEMBER, "crm", POST, APP_READ))).code).toBe("forbidden");
    });

    it("lets a write-level viewer write through a read-write declaration on a read-write connection", async () => {
      const t = setup();
      expect((await t.service.call(C, MEMBER, "crm", POST, APP_RW)).status).toBe(200);
      expect(t.fetches[0]!.init.method).toBe("POST");
    });

    it("refuses a write on a read connection whatever the level and declaration", async () => {
      const t = setup();
      expect((await refusal(t.service.call(C, MEMBER, "ro", POST, APP_RW))).code).toBe("forbidden");
    });

    it("refuses an agent as an app's viewer", async () => {
      const t = setup();
      expect((await refusal(t.service.call(C, AGENT, "crm", GET, APP_READ))).code).toBe("forbidden");
    });
  });

  describe("an agent calling directly", () => {
    it("refuses an agent without a grant, whatever its data level", async () => {
      const t = setup();
      expect((await refusal(t.service.call(C, AGENT_NONE, "crm", GET, DIRECT))).code).toBe("forbidden");
      expect(t.fetches).toHaveLength(0);
    });

    it("lets a read grant GET and refuses its write", async () => {
      const t = setup();
      expect((await t.service.call(C, AGENT_RO, "crm", GET, DIRECT)).status).toBe(200);
      expect((await refusal(t.service.call(C, AGENT_RO, "crm", POST, DIRECT))).code).toBe("forbidden");
    });

    it("lets a read-write grant write on a read-write connection", async () => {
      const t = setup();
      expect((await t.service.call(C, AGENT, "crm", POST, DIRECT)).status).toBe(200);
    });

    it("never widens a read connection: a read-write grant still cannot write", async () => {
      const t = setup();
      expect((await t.service.call(C, AGENT, "ro", GET, DIRECT)).status).toBe(200);
      expect((await refusal(t.service.call(C, AGENT, "ro", POST, DIRECT))).code).toBe("forbidden");
    });
  });

  describe("a person calling directly", () => {
    it("lets an owner by role call whatever their level", async () => {
      const t = setup();
      expect((await t.service.call(C, OWNER, "crm", POST, DIRECT)).status).toBe(200);
    });

    it("refuses an owner's write on a read connection", async () => {
      const t = setup();
      expect((await refusal(t.service.call(C, OWNER, "ro", POST, DIRECT))).code).toBe("forbidden");
    });

    it("lets a write-level member write and a read-level viewer only read", async () => {
      const t = setup();
      expect((await t.service.call(C, MEMBER, "crm", POST, DIRECT)).status).toBe(200);
      expect((await t.service.call(C, VIEWER, "crm", GET, DIRECT)).status).toBe(200);
      expect((await refusal(t.service.call(C, VIEWER, "crm", POST, DIRECT))).code).toBe("forbidden");
    });

    it("refuses a person with no level", async () => {
      const t = setup();
      expect((await refusal(t.service.call(C, STRANGER, "crm", GET, DIRECT))).code).toBe("forbidden");
    });
  });

  it("refuses a system actor", async () => {
    const t = setup();
    expect((await refusal(t.service.call(C, { kind: "system", id: null }, "crm", GET, DIRECT))).code).toBe("forbidden");
  });
});

describe("ConnectionService.call: the request", () => {
  it("sends the built URL, the auth header and the body as text", async () => {
    const t = setup();
    await t.service.call(C, MEMBER, "crm", { method: "post", path: "contacts/1", query: { q: "x y" }, headers: { accept: "application/json" }, body: { a: 1 } }, DIRECT);
    expect(t.fetches).toEqual([{
      url: "https://api.crm.example/v1/contacts/1?q=x+y",
      init: { method: "POST", headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${SECRET}` }, body: '{"a":1}' },
    }]);
  });

  it("sends no body key for a GET", async () => {
    const t = setup();
    await t.service.call(C, VIEWER, "ro", GET, APP_READ);
    expect(t.fetches[0]!.init).toEqual({ method: "GET", headers: { "x-api-key": SECRET } });
  });

  it("refuses bad input as invalid before anything else", async () => {
    const t = setup();
    expect((await refusal(t.service.call(C, MEMBER, "crm", { method: "TRACE" }, DIRECT))).code).toBe("invalid");
    expect((await refusal(t.service.call(C, MEMBER, "Bad Name", GET, DIRECT))).code).toBe("invalid");
    expect((await refusal(t.service.call("not-a-uuid", MEMBER, "crm", GET, DIRECT))).code).toBe("invalid");
    expect(t.audits).toHaveLength(0);
  });

  it("refuses a path that leaves the base URL", async () => {
    const t = setup();
    expect((await refusal(t.service.call(C, MEMBER, "crm", { path: "../admin" }, DIRECT))).code).toBe("invalid");
    expect(t.fetches).toHaveLength(0);
  });
});

describe("ConnectionService.call: a missing connection", () => {
  it("is disabled, with the app wording for an app", async () => {
    const t = setup();
    const error = await refusal(t.service.call(C, VIEWER, "stripe", GET, APP_READ));
    expect(error.code).toBe("disabled");
    expect(error.message).toBe("disabled: This app's connection 'stripe' isn't set up. Ask a company admin.");
  });

  it("is disabled, with a set-up hint for a direct call", async () => {
    const t = setup();
    const error = await refusal(t.service.call(C, AGENT, "stripe", GET, DIRECT));
    expect(error.code).toBe("disabled");
    expect(error.message).toBe("disabled: The connection 'stripe' isn't set up. Ask a company admin to set it up.");
  });

  it("writes no audit row", async () => {
    const t = setup();
    await refusal(t.service.call(C, AGENT, "stripe", GET, DIRECT));
    expect(t.audits).toHaveLength(0);
  });
});

describe("ConnectionService.call: the secret", () => {
  it("is disabled when the secret cannot be read, and never repeats the core's error", async () => {
    const t = setup({ resolve: async () => { throw new Error(`secret ${SECRET} is archived`); } });
    const error = await refusal(t.service.call(C, MEMBER, "crm", GET, DIRECT));
    expect(error.code).toBe("disabled");
    expect(error.message).toBe("disabled: the connection 'crm' secret could not be read; check the secret picked in the plugin settings");
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain("archived");
    expect(t.fetches).toHaveLength(0);
  });

  it("treats an empty secret as not set up", async () => {
    const t = setup({ resolve: async () => "" });
    expect((await refusal(t.service.call(C, MEMBER, "crm", GET, DIRECT))).code).toBe("disabled");
    expect((await t.service.list(C, MEMBER)).map((c) => c.available)).toEqual([false, false]);
  });

  it.each([["a trailing newline", `${SECRET}\n`], ["a carriage return", `${SECRET}\r`], ["a tab", `sk\tlive`], ["a NUL", `sk\0live`]])(
    "treats a bearer or header secret with %s as not usable, without blaming the caller",
    async (_label, value) => {
      const t = setup({ resolve: async () => value });
      for (const name of ["crm", "ro"]) {
        const error = await refusal(t.service.call(C, MEMBER, name, GET, DIRECT));
        expect(error.code).toBe("disabled");
        expect(error.message).toContain("the secret contains a line break or other control character");
        expect(error.message).not.toContain(SECRET);
      }
      expect(t.fetches).toHaveLength(0);
      expect((await t.service.list(C, MEMBER)).map((c) => c.available)).toEqual([false, false]);
      expect((await t.service.status(C)).connections.map((c) => c.problem)).toEqual([
        "the secret contains a line break or other control character",
        "the secret contains a line break or other control character",
      ]);
      // A cached value: no further lookups for it.
      expect(t.resolves).toHaveLength(2);
    },
  );

  it("still sends a basic-auth secret with a newline, which is base64-encoded", async () => {
    const BASIC = { name: "basic", baseUrl: "https://api.basic.example/", auth: "basic", secret: REF, methods: "read" };
    const t = setup({ config: { connections: [BASIC] }, resolve: async () => "user:pa\nss" });
    expect((await t.service.call(C, MEMBER, "basic", GET, DIRECT)).status).toBe(200);
    expect((await t.service.status(C)).connections[0]?.problem).toBeNull();
  });

  it("is resolved once per config path, and again when the config moves the connection", async () => {
    const t = setup();
    await t.service.call(C, MEMBER, "crm", GET, DIRECT);
    await t.service.call(C, MEMBER, "crm", GET, DIRECT);
    expect(t.resolves).toEqual([{ binding: REF, configPath: "connections.0.secret" }]);
    t.setConfig({ connections: [RO, CRM] });
    await t.service.call(C, MEMBER, "crm", GET, DIRECT);
    expect(t.resolves).toEqual([{ binding: REF, configPath: "connections.0.secret" }, { binding: REF, configPath: "connections.1.secret" }]);
  });
});

describe("ConnectionService.call: the response", () => {
  it("maps the SDK's refusal to build a 204 response to an empty answer", async () => {
    const t = setup({ respond: async () => { throw new TypeError("Response constructor: Invalid response status code 204"); } });
    expect(await t.service.call(C, MEMBER, "crm", { method: "DELETE", path: "contacts/1" }, DIRECT)).toEqual({ status: 204, headers: {}, body: "" });
  });

  it("maps a 304 the same way", async () => {
    const t = setup({ respond: async () => { throw new TypeError("Invalid response status code 304"); } });
    expect(await t.service.call(C, VIEWER, "crm", GET, APP_READ)).toEqual({ status: 304, headers: {}, body: "" });
  });

  it.each(["Invalid response status code 200", "Response constructor: Invalid response status code 101", "Invalid response status code 2040"])(
    "keeps any other refused status (%s) as provider_unavailable (R11c)",
    async (message) => {
      const t = setup({ respond: async () => { throw new RangeError(message); } });
      expect((await refusal(t.service.call(C, MEMBER, "crm", GET, DIRECT))).code).toBe("provider_unavailable");
    },
  );

  it("maps a 205 to an empty answer", async () => {
    const t = setup({ respond: async () => { throw new TypeError("Response constructor: Invalid response status code 205"); } });
    expect(await t.service.call(C, MEMBER, "crm", { method: "PUT", path: "contacts/1" }, DIRECT)).toEqual({ status: 205, headers: {}, body: "" });
  });

  it.each([
    'Worker→host call "http.fetch" timed out after 30000ms',
    "The operation was aborted",
    "connect ETIMEDOUT 203.0.113.9:443",
  ])("maps the core's timeout (%s) to timeout", async (message) => {
    const t = setup({ respond: async () => { throw new Error(`${message} https://api.crm.example/v1/contacts?token=QVALUE ${SECRET}`); } });
    const error = await refusal(t.service.call(C, MEMBER, "crm", { path: "contacts", query: { token: "QVALUE" } }, DIRECT));
    expect(error.code).toBe("timeout");
    expect(error.message).not.toContain("QVALUE");
    expect(error.message).not.toContain(SECRET);
    expect(error.message).toContain("crm");
  });

  it.each([
    "All resolved IPs for api.crm.example are in private/reserved ranges",
    "DNS resolution failed for api.crm.example: getaddrinfo ENOTFOUND",
    "read ECONNRESET",
    "Invalid URL: https://api.crm.example/v1/contacts?token=QVALUE",
  ])("maps a network failure (%s) to provider_unavailable without the raw error", async (message) => {
    const t = setup({ respond: async () => { throw new Error(`${message} ${SECRET}`); } });
    const error = await refusal(t.service.call(C, MEMBER, "crm", { path: "contacts", query: { token: "QVALUE" } }, DIRECT));
    expect(error.code).toBe("provider_unavailable");
    expect(error.message).toBe("provider_unavailable: the connection 'crm' could not be reached; try again later");
    expect(error.cause).toBeUndefined();
  });

  it("filters response headers, so an echoed authorization or a cookie never comes back", async () => {
    const t = setup({
      respond: async () => new Response("hi", {
        status: 201,
        headers: { authorization: `Bearer ${SECRET}`, "set-cookie": "sid=1", "content-type": "text/plain", "x-ratelimit-remaining": "9", "x-api-key": SECRET },
      }),
    });
    const result = await t.service.call(C, MEMBER, "crm", POST, DIRECT);
    expect(result).toEqual({ status: 201, headers: { "content-type": "text/plain", "x-ratelimit-remaining": "9" }, body: "hi" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("returns a 3xx and a 4xx as they are", async () => {
    const answers = [
      new Response("moved", { status: 302, headers: { location: "https://elsewhere.example/", "content-type": "text/plain" } }),
      new Response("slow down", { status: 429, headers: { "retry-after": "5", "content-type": "text/plain" } }),
    ];
    const t = setup({ respond: async () => answers.shift()! });
    expect(await t.service.call(C, MEMBER, "crm", GET, DIRECT)).toEqual({ status: 302, headers: { location: "https://elsewhere.example/", "content-type": "text/plain" }, body: "moved" });
    expect(await t.service.call(C, MEMBER, "crm", GET, DIRECT)).toEqual({ status: 429, headers: { "retry-after": "5", "content-type": "text/plain" }, body: "slow down" });
  });

  it("refuses a response over 2 MiB as too_large", async () => {
    const t = setup({ respond: async () => new Response("x".repeat(2 * 1024 * 1024 + 1), { status: 200 }) });
    expect((await refusal(t.service.call(C, MEMBER, "crm", GET, DIRECT))).code).toBe("too_large");
  });
});

describe("ConnectionService.call: the guardrail", () => {
  const EXPECTED_PARAMS = (path: string, method: string, query: Record<string, string>, body: string | null) => ({
    connection: "crm",
    method,
    path,
    queryHash: sha256(JSON.stringify(Object.fromEntries(Object.keys(query).sort().map((k) => [k, query[k]])))),
    bodyHash: sha256(body ?? ""),
  });

  it("asks before an agent's write, with the subject and all five params", async () => {
    const t = setup();
    await t.service.call(C, AGENT, "crm", { method: "PATCH", path: "contacts/7", query: { b: "2", a: "1" }, body: "raw" }, DIRECT, { issueId: "iss-1" });
    expect(t.guardCalls).toHaveLength(1);
    const action = t.guardCalls[0]!;
    expect(action).toMatchObject({ operation: "connection_write", companyId: C, actor: AGENT, guard: { issueId: "iss-1" }, connection: "crm", method: "PATCH", path: "contacts/7" });
    expect(action.params).toEqual(EXPECTED_PARAMS("contacts/7", "PATCH", { a: "1", b: "2" }, "raw"));
    expect(t.fetches).toHaveLength(1);
  });

  it("fingerprints differ when the path, method, query or body change", async () => {
    const t = setup();
    const base = { method: "POST", path: "contacts", query: { a: "1" }, body: "one" };
    for (const call of [base, { ...base, path: "contacts/2" }, { ...base, method: "PUT" }, { ...base, query: { a: "2" } }, { ...base, body: "two" }, { ...base, query: { a: "1" } }]) {
      await t.service.call(C, AGENT, "crm", call, DIRECT);
    }
    const prints = t.guardCalls.map((action) => actionFingerprint(action));
    expect(new Set(prints.slice(0, 5)).size).toBe(5);
    expect(prints[5]).toBe(prints[0]);
  });

  it("never asks for a GET, a person's write or an app's write", async () => {
    const t = setup();
    await t.service.call(C, AGENT, "crm", GET, DIRECT);
    await t.service.call(C, MEMBER, "crm", POST, DIRECT);
    await t.service.call(C, MEMBER, "crm", POST, APP_RW);
    expect(t.guardCalls).toHaveLength(0);
  });

  it("asks only once the path is validated, and only for an authorised call", async () => {
    const t = setup();
    await refusal(t.service.call(C, AGENT, "crm", { method: "POST", path: "../x" }, DIRECT));
    await refusal(t.service.call(C, AGENT_RO, "crm", POST, DIRECT));
    expect(t.guardCalls).toHaveLength(0);
  });

  it("does not call out when the guardrail holds the call, and audits the hold", async () => {
    const t = setup();
    const held = new DataError("held", "waiting for a person");
    const service = new ConnectionService({ ...t.deps, guardAgentAction: async () => { throw held; } });
    expect(await refusal(service.call(C, AGENT, "crm", POST, DIRECT))).toBe(held);
    expect(t.fetches).toHaveLength(0);
    expect(t.audits.at(-1)!.details).toMatchObject({ outcome: "held", status: null });
  });

  it("reads the secret before asking, so a confirmation is never spent on a disabled call (R11b)", async () => {
    const t = setup({ resolve: async () => { throw new Error("gone"); } });
    expect((await refusal(t.service.call(C, AGENT, "crm", POST, DIRECT))).code).toBe("disabled");
    expect(t.guardCalls).toHaveLength(0);
  });

  it("goes ahead without a guardrail wired", async () => {
    const t = setup({ guard: false });
    expect((await t.service.call(C, AGENT, "crm", POST, DIRECT)).status).toBe(200);
  });
});

describe("ConnectionService.call: the 25 s deadline (R10)", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("is 25 s", () => { expect(CALL_DEADLINE_MS).toBe(25_000); });

  it("gives timeout at 25 s for a fetch that never answers, and audits it", async () => {
    vi.useFakeTimers();
    const t = setup({ respond: () => new Promise<Response>(() => {}) });
    let settled: DataError | null = null;
    void t.service.call(C, MEMBER, "crm", GET, DIRECT).catch((error: DataError) => { settled = error; });
    await vi.advanceTimersByTimeAsync(CALL_DEADLINE_MS - 1);
    expect(settled).toBeNull();
    t.clock.t += CALL_DEADLINE_MS;
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBeInstanceOf(DataError);
    expect(settled!.code).toBe("timeout");
    expect(settled!.message).toBe("timeout: the connection 'crm' did not answer in time (a call may take at most 25 s)");
    expect(t.audits.at(-1)!.details).toMatchObject({ status: null, outcome: "timeout", ms: CALL_DEADLINE_MS });
  });

  it("gives the fetch only what the guardrail left of the 25 s", async () => {
    vi.useFakeTimers();
    const t = setup({ respond: () => new Promise<Response>(() => {}) });
    const service = new ConnectionService({ ...t.deps, guardAgentAction: async () => { t.clock.t += 10_000; } });
    let settled: DataError | null = null;
    void service.call(C, AGENT, "crm", POST, DIRECT).catch((error: DataError) => { settled = error; });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled!.code).toBe("timeout");
  });

  it("does not call out once the guardrail used the whole 25 s", async () => {
    const t = setup();
    const service = new ConnectionService({ ...t.deps, guardAgentAction: async () => { t.clock.t += CALL_DEADLINE_MS; } });
    expect((await refusal(service.call(C, AGENT, "crm", POST, DIRECT))).code).toBe("timeout");
    expect(t.fetches).toHaveLength(0);
  });
});

describe("ConnectionService.call: audit and activity", () => {
  it("audits a completed call without query values, body or headers", async () => {
    const t = setup();
    await t.service.call(C, AGENT, "crm", { method: "POST", path: "contacts", query: { email: "ada@example.com" }, body: { secret: "BODYVALUE" } }, DIRECT);
    expect(t.audits).toHaveLength(1);
    const row = t.audits[0]!;
    expect(row).toMatchObject({ operation: "connection_call", actorKind: "agent", actorId: "agent-1", runId: "run-1" });
    expect(row.details).toEqual({ connection: "crm", method: "POST", path: "contacts", status: 200, ms: expect.any(Number), bytes: 11, via: "agent" });
    const text = JSON.stringify(row);
    for (const leak of ["ada@example.com", "BODYVALUE", SECRET, "authorization"]) expect(text).not.toContain(leak);
  });

  it("names the app and version, or a person, in via", async () => {
    const t = setup();
    await t.service.call(C, VIEWER, "crm", GET, APP_READ);
    await t.service.call(C, MEMBER, "crm", GET, DIRECT);
    expect(t.audits.map((row) => row.details.via)).toEqual(["app@dash@3", "person"]);
  });

  it("audits a refusal after the connection was found, with its outcome", async () => {
    const t = setup();
    await refusal(t.service.call(C, AGENT_NONE, "crm", GET, DIRECT));
    expect(t.audits).toHaveLength(1);
    expect(t.audits[0]!.details).toEqual({ connection: "crm", method: "GET", path: "contacts", status: null, ms: null, bytes: null, via: "agent", outcome: "forbidden" });
  });

  it("audits a failed call with its outcome", async () => {
    const t = setup({ respond: async () => { throw new Error("read ECONNRESET"); } });
    await refusal(t.service.call(C, MEMBER, "crm", GET, DIRECT));
    expect(t.audits[0]!.details).toMatchObject({ status: null, outcome: "provider_unavailable", ms: expect.any(Number) });
  });

  it("logs activity for an agent's call only", async () => {
    const t = setup();
    await t.service.call(C, AGENT, "crm", { method: "post", path: "contacts", query: { q: "secret-query" } }, DIRECT);
    await t.service.call(C, MEMBER, "crm", GET, DIRECT);
    await t.service.call(C, VIEWER, "crm", GET, APP_READ);
    expect(t.activity).toEqual([{ companyId: C, actor: AGENT, summary: "connection crm: POST contacts → 200", connection: "crm" }]);
  });

  it("does not fail a completed call when the activity log fails, and tells the operator", async () => {
    const t = setup();
    const service = new ConnectionService({ ...t.deps, onActivity: async () => { throw new Error("down"); } });
    expect((await service.call(C, AGENT, "crm", GET, DIRECT)).status).toBe(200);
    expect(t.logs).toEqual([{ message: "connection activity log failed", meta: expect.objectContaining({ connection: "crm", method: "GET", path: "contacts", status: 200 }) }]);
  });

  it("returns a completed write when its audit row fails, and logs it without contents (R9)", async () => {
    const t = setup({ auditFails: () => true });
    const result = await t.service.call(C, MEMBER, "crm", { method: "POST", path: "contacts", query: { email: "ada@example.com" }, body: { note: "BODYVALUE" } }, DIRECT);
    expect(result.status).toBe(200);
    expect(t.logs).toEqual([{ message: "connection call audit failed", meta: expect.objectContaining({ companyId: C, connection: "crm", method: "POST", path: "contacts", status: 200 }) }]);
    const text = JSON.stringify(t.logs);
    for (const leak of ["ada@example.com", "BODYVALUE", SECRET]) expect(text).not.toContain(leak);
  });

  it("fails a GET closed when its audit row fails (R9)", async () => {
    const t = setup({ auditFails: () => true });
    await expect(t.service.call(C, MEMBER, "crm", GET, DIRECT)).rejects.toThrow("audit insert refused");
    expect(t.fetches).toHaveLength(1);
  });

  it("still throws the refusal when its audit row fails, and logs the audit failure", async () => {
    const t = setup({ auditFails: () => true });
    expect((await refusal(t.service.call(C, AGENT_NONE, "crm", GET, DIRECT))).code).toBe("forbidden");
    expect(t.logs).toEqual([{ message: "connection call audit failed", meta: expect.objectContaining({ connection: "crm", outcome: "forbidden" }) }]);
  });
});

describe("ConnectionService.list and status", () => {
  it("lists every connection with availability and the caller's access, never the secret", async () => {
    const t = setup();
    const agentView = await t.service.list(C, AGENT_RO);
    expect(agentView).toEqual([
      { name: "crm", baseUrl: "https://api.crm.example/v1/", auth: "bearer", methods: "read-write", available: true, access: "read" },
      { name: "ro", baseUrl: "https://api.ro.example/", auth: "header", methods: "read", available: true, access: "none" },
    ]);
    expect(JSON.stringify(agentView)).not.toContain("s-crm");
    expect((await t.service.list(C, AGENT)).map((c) => c.access)).toEqual(["read-write", "read"]);
    expect((await t.service.list(C, MEMBER)).map((c) => c.access)).toEqual(["read-write", "read"]);
    expect((await t.service.list(C, VIEWER)).map((c) => c.access)).toEqual(["read", "read"]);
    expect((await t.service.list(C, OWNER)).map((c) => c.access)).toEqual(["read-write", "read"]);
  });

  it("lists for any agent, and refuses a person without read", async () => {
    const t = setup();
    expect((await t.service.list(C, AGENT_NONE)).map((c) => c.access)).toEqual(["none", "none"]);
    expect((await refusal(t.service.list(C, STRANGER))).code).toBe("forbidden");
  });

  it("does not retry a failed secret for 60 s on availability checks, but a call tries again after 15 s", async () => {
    let fail = true;
    const t = setup({ resolve: async () => { if (fail) throw new Error("no"); return SECRET; } });
    expect((await t.service.list(C, AGENT)).map((c) => c.available)).toEqual([false, false]);
    expect(t.resolves).toHaveLength(2);
    t.clock.t += 59_999;
    fail = false;
    expect((await t.service.list(C, AGENT)).map((c) => c.available)).toEqual([false, false]);
    expect((await t.service.status(C)).connections.map((c) => c.available)).toEqual([false, false]);
    expect(t.resolves).toHaveLength(2);
    // A call resolves afresh even inside the window, and its success makes the connection available.
    expect((await t.service.call(C, AGENT, "crm", GET, DIRECT)).status).toBe(200);
    expect(t.resolves).toHaveLength(3);
    expect((await t.service.list(C, AGENT)).map((c) => c.available)).toEqual([true, false]);
    t.clock.t += 1;
    expect((await t.service.list(C, AGENT)).map((c) => c.available)).toEqual([true, true]);
    expect(t.resolves).toHaveLength(4);
  });

  it("resolves a good secret at most once a minute for availability", async () => {
    const t = setup();
    await t.service.list(C, AGENT);
    await t.service.status(C);
    await t.service.list(C, MEMBER);
    expect(t.resolves).toHaveLength(2);
  });

  it("forgets a failure on invalidate", async () => {
    let fail = true;
    const t = setup({ resolve: async () => { if (fail) throw new Error("no"); return SECRET; } });
    await t.service.list(C, AGENT);
    fail = false;
    t.service.invalidate(C);
    expect((await t.service.list(C, AGENT)).map((c) => c.available)).toEqual([true, true]);
  });

  it("reports parse problems and unresolvable secrets for the admin page", async () => {
    const t = setup({
      config: { connections: [CRM, { name: "Bad" }, RO] },
      resolve: async (binding) => { if ((binding as { secretId: string }).secretId === "s-ro") throw new Error("gone"); return SECRET; },
    });
    expect(await t.service.status(C)).toEqual({
      connections: [
        { name: "crm", baseUrl: "https://api.crm.example/v1/", auth: "bearer", methods: "read-write", available: true, problem: null },
        { name: "ro", baseUrl: "https://api.ro.example/", auth: "header", methods: "read", available: false, problem: "secret doesn't resolve" },
      ],
      problems: [{ index: 1, name: "Bad", problem: expect.stringContaining("lower-case") }],
    });
  });
});

/** The core's limiter (plugin-secrets-handler): 30 lookups a minute per company and plugin, failed ones counted, refused ones not. */
function coreLimiter(clock: { t: number }) {
  const attempts: number[] = [];
  return {
    attempts,
    check(): void {
      const recent = attempts.filter((at) => at > clock.t - 60_000);
      if (recent.length >= 30) {
        const error = new Error("Rate limit exceeded for secret resolution");
        error.name = "RateLimitExceededError";
        throw error;
      }
      attempts.push(clock.t);
    },
  };
}

function deferred<T>() {
  let settle!: { resolve(value: T): void; reject(error: unknown): void };
  const promise = new Promise<T>((resolve, reject) => { settle = { resolve, reject }; });
  return { promise, ...settle };
}

describe("ConnectionService: the secret lookup budget (R14)", () => {
  const ONLY_CRM = { connections: [CRM] };

  it("is 15 s between a call's lookups after a failure", () => { expect(SECRET_CALL_RETRY_MS).toBe(15_000); });

  it("asks for a failing secret once per 15 s however often calls come, and answers disabled meanwhile", async () => {
    const t = setup({ config: ONLY_CRM, resolve: async () => { throw new Error("Secret is not bound to plugin"); } });
    const start = t.clock.t;
    for (let i = 0; i < 40; i++) {
      const error = await refusal(t.service.call(C, MEMBER, "crm", GET, DIRECT));
      expect(error.message).toBe("disabled: the connection 'crm' secret could not be read; check the secret picked in the plugin settings");
      t.clock.t += 300;
    }
    expect(t.clock.t - start).toBeLessThan(SECRET_CALL_RETRY_MS);
    expect(t.resolves).toHaveLength(1);
    // Availability checks keep their own 60 s back-off and do not ask either.
    expect((await t.service.status(C)).connections[0]).toMatchObject({ available: false, problem: "secret doesn't resolve" });
    expect(t.resolves).toHaveLength(1);
    t.clock.t = start + SECRET_CALL_RETRY_MS;
    expect((await refusal(t.service.call(C, MEMBER, "crm", GET, DIRECT))).code).toBe("disabled");
    expect(t.resolves).toHaveLength(2);
    expect(t.fetches).toHaveLength(0);
  });

  it("leaves the company's budget for typed decisions while an app polls a broken connection", async () => {
    const clock = { t: 1_000_000 };
    const limiter = coreLimiter(clock);
    const secrets = new SecretCache({
      resolve: async (binding) => {
        limiter.check();
        if ((binding as { secretId: string }).secretId === "s-crm") throw new Error("Secret is not bound to plugin");
        return "decisions-key";
      },
      now: () => clock.t,
    });
    const t = setup({ config: ONLY_CRM });
    const service = new ConnectionService({ ...t.deps, secrets, now: () => clock.t });
    // An app polling once a second for two minutes, and its gallery card listing every five.
    for (let second = 0; second < 120; second++) {
      expect((await refusal(service.call(C, VIEWER, "crm", GET, APP_READ))).code).toBe("disabled");
      if (second % 5 === 0) expect((await service.list(C, VIEWER))[0]?.available).toBe(false);
      clock.t += 1_000;
    }
    // At most one lookup per 15 s: far below the core's 30 a minute.
    expect(limiter.attempts.length).toBeLessThanOrEqual(9);
    expect(limiter.attempts.filter((at) => at > clock.t - 60_000).length).toBeLessThanOrEqual(5);
    await expect(secrets.get(C, "decisions", { type: "secret_ref", secretId: "s-dec" }, "decisions.apiKey")).resolves.toBe("decisions-key");
  });

  it("treats the core's rate limit as a short wait, not a broken secret", async () => {
    let mode: "limited" | "rpc" | "ok" = "limited";
    const t = setup({
      config: ONLY_CRM,
      resolve: async () => {
        if (mode === "ok") return SECRET;
        // On the host it is a RateLimitExceededError; through the worker RPC only its message arrives.
        const error = new Error("Rate limit exceeded for secret resolution");
        error.name = mode === "limited" ? "RateLimitExceededError" : "JsonRpcCallError";
        throw error;
      },
    });
    const error = await refusal(t.service.call(C, MEMBER, "crm", GET, DIRECT));
    expect(error.code).toBe("limit");
    expect(error.message).toContain("too many secret lookups");
    expect((await t.service.status(C)).connections[0]).toMatchObject({ available: false, problem: "too many secret lookups just now; try again in a minute" });
    expect((await refusal(t.service.call(C, MEMBER, "crm", GET, DIRECT))).code).toBe("limit");
    expect(t.resolves).toHaveLength(1);

    t.clock.t += SECRET_CALL_RETRY_MS;
    mode = "rpc";
    expect((await refusal(t.service.call(C, MEMBER, "crm", GET, DIRECT))).code).toBe("limit");
    expect(t.resolves).toHaveLength(2);

    // Not a minute: 15 s after the refusal, the connection is ready again.
    t.clock.t += SECRET_CALL_RETRY_MS;
    mode = "ok";
    expect((await t.service.list(C, MEMBER))[0]?.available).toBe(true);
    expect((await t.service.call(C, MEMBER, "crm", GET, DIRECT)).status).toBe(200);
  });

  it("asks again at once after a config change", async () => {
    let fail = true;
    const t = setup({ config: ONLY_CRM, resolve: async () => { if (fail) throw new Error("no"); return SECRET; } });
    await refusal(t.service.call(C, MEMBER, "crm", GET, DIRECT));
    await refusal(t.service.call(C, MEMBER, "crm", GET, DIRECT));
    expect(t.resolves).toHaveLength(1);
    fail = false;
    t.deps.secrets.invalidate(C);
    t.service.invalidate(C);
    expect((await t.service.call(C, MEMBER, "crm", GET, DIRECT)).status).toBe(200);
    expect(t.resolves).toHaveLength(2);
  });

  it("forgets every company's back-off when invalidated without a company", async () => {
    let fail = true;
    const t = setup({ config: ONLY_CRM, resolve: async () => { if (fail) throw new Error("no"); return SECRET; } });
    await refusal(t.service.call(C, MEMBER, "crm", GET, DIRECT));
    fail = false;
    t.service.invalidate();
    expect((await t.service.list(C, MEMBER))[0]?.available).toBe(true);
  });

  it("never records a back-off from a lookup that started before a config change", async () => {
    let pending = deferred<string>();
    const t = setup({ config: ONLY_CRM, resolve: () => pending.promise });
    const listing = t.service.list(C, MEMBER);
    const calling = t.service.call(C, MEMBER, "crm", GET, DIRECT).catch((error: unknown) => error);
    // Both are now waiting on the one lookup, started under the old config.
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.resolves).toHaveLength(1);
    t.deps.secrets.invalidate(C);
    t.service.invalidate(C);
    pending.reject(new Error("old binding gone"));
    expect((await listing)[0]?.available).toBe(false);
    expect(((await calling) as DataError).code).toBe("disabled");

    // The new config's secret is asked for straight away, by a list and by a call.
    pending = deferred<string>();
    pending.resolve(SECRET);
    const before = t.resolves.length;
    expect((await t.service.list(C, MEMBER))[0]?.available).toBe(true);
    expect(t.resolves.length).toBe(before + 1);
    expect((await t.service.call(C, MEMBER, "crm", GET, DIRECT)).status).toBe(200);
  });
});

describe("ConnectionService grants admin", () => {
  it("lists and sets grants for owners and admins only, by fresh role", async () => {
    const t = setup();
    const fresh: boolean[] = [];
    const service = new ConnectionService({
      ...t.deps,
      resolveUserRole: async (_c, userId, isFresh) => { fresh.push(isFresh); return ROLES[userId] ?? null; },
    });
    expect((await service.listGrants(C, OWNER)).map((g) => `${g.agentId}/${g.connection}/${g.access}`)).toContain("agent-ro/crm/read");
    for (const actor of [MEMBER, VIEWER, AGENT]) {
      expect((await refusal(service.listGrants(C, actor))).code).toBe("forbidden");
      expect((await refusal(service.setGrant(C, actor, "agent-2", "crm", "read"))).code).toBe("forbidden");
    }
    expect(fresh.every(Boolean)).toBe(true);
  });

  it("validates a grant's agent and connection name", async () => {
    const t = setup();
    expect((await refusal(t.service.setGrant(C, OWNER, "", "crm", "read"))).code).toBe("invalid");
    expect((await refusal(t.service.setGrant(C, OWNER, "agent-2", "Bad Name", "read"))).code).toBe("invalid");
    expect((await refusal(t.service.setGrant(C, OWNER, "agent-2", "crm", "admin" as never))).code).toBe("invalid");
  });
});

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
