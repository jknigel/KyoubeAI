import type { DataService } from "../src/data/service.js";

/**
 * Records every call; each method returns a recognisable value or throws
 * `fail` when it is given. `fail` is typed as the broader `Error` (rather
 * than `DataError`) so callers can simulate either a `DataError` or a plain
 * internal error (e.g. a driver failure) from the same helper.
 */
export function createStubService(fail?: Error) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const handler: ProxyHandler<object> = {
    get(_target, method: string) {
      if (method === "then") return undefined;
      return async (...args: unknown[]) => {
        calls.push({ method, args });
        if (fail) throw fail;
        if (method === "myAccess") return { level: "write", actorKind: "agent", hint: "ok" };
        if (method === "listTables") return [{ name: "contacts", displayName: "Contacts", description: null, fields: [], createdAt: "", updatedAt: "" }];
        if (method === "count") return 3;
        return { method, args };
      };
    },
  };
  return { service: new Proxy({}, handler) as unknown as DataService, calls };
}
