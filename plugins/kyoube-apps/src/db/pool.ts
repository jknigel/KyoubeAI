import pg from "pg";

export type { Pool, PoolClient } from "pg";

let configured = false;

/** Dates stay "YYYY-MM-DD" strings, bigints become numbers when safe, numerics become numbers. */
export function configureTypeParsers(): void {
  if (configured) return;
  configured = true;
  pg.types.setTypeParser(1082, (value) => value); // date
  pg.types.setTypeParser(20, (value) => { const n = Number(value); return Number.isSafeInteger(n) ? n : value; }); // int8
  pg.types.setTypeParser(1700, (value) => Number(value)); // numeric
}

export function createPool(url: string, opts: { max?: number } = {}): pg.Pool {
  configureTypeParsers();
  return new pg.Pool({ connectionString: url, max: opts.max ?? 8, application_name: "kyoube-apps" });
}
