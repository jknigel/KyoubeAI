import { describe, expect, it } from "vitest";
import { DataError, mapPgError } from "../../src/data/errors.js";

describe("mapPgError", () => {
  it("maps known Postgres SQLSTATE codes to the matching DataError code", () => {
    expect(mapPgError({ code: "23505", detail: "Key (name)=(x) already exists." })).toMatchObject({ code: "conflict" });
    expect(mapPgError({ code: "42P07", message: 'relation "x" already exists' })).toMatchObject({ code: "conflict" });
    expect(mapPgError({ code: "23514" })).toMatchObject({ code: "invalid" });
    expect(mapPgError({ code: "23502" })).toMatchObject({ code: "invalid" });
    expect(mapPgError({ code: "23503" })).toMatchObject({ code: "invalid" });
    expect(mapPgError({ code: "22P02" })).toMatchObject({ code: "invalid" });
    expect(mapPgError({ code: "42703" })).toMatchObject({ code: "not_found" });
    expect(mapPgError({ code: "42P01" })).toMatchObject({ code: "not_found" });
    expect(mapPgError({ code: "57014" })).toMatchObject({ code: "limit" });
    expect(mapPgError({ code: "42501" })).toMatchObject({ code: "forbidden" });
    expect(mapPgError({ code: "23505", detail: "boom" })).toBeInstanceOf(DataError);
  });

  it("names the constraint or column but never the offending value (P4-R15)", () => {
    const unique = mapPgError({
      code: "23505",
      message: 'duplicate key value violates unique constraint "contacts_email_idx"',
      detail: "Key (email)=(ada@example.com) already exists.",
      constraint: "contacts_email_idx",
      table: "contacts",
    })!;
    expect(unique.message).toContain("contacts_email_idx");
    expect(unique.message).not.toContain("ada@example.com");
    expect(unique.message).not.toContain("Key (email)");

    const check = mapPgError({
      code: "23514",
      message: 'new row for relation "deals" violates check constraint "deals_stage_choices"',
      detail: "Failing row contains (7f0c…, Secret deal, 9000, lost).",
      constraint: "deals_stage_choices",
    })!;
    expect(check.message).toContain("deals_stage_choices");
    expect(check.message).not.toContain("Secret deal");

    const notNull = mapPgError({ code: "23502", detail: "Failing row contains (1, null).", column: "title" })!;
    expect(notNull.message).toContain("title");
    expect(notNull.message).not.toContain("Failing row");

    // Nothing to name: the message stays generic rather than falling back to the driver's text.
    const cast = mapPgError({ code: "22P02", message: 'invalid input syntax for type uuid: "Ada"', detail: "…" })!;
    expect(cast.message).toBe("invalid: invalid value");
  });

  it("returns null for unmapped Postgres codes and non-Postgres errors", () => {
    expect(mapPgError({ code: "40001" })).toBeNull(); // serialization_failure: real SQLSTATE, just not one we map
    expect(mapPgError(new Error("boom"))).toBeNull();
    expect(mapPgError(new DataError("conflict", "already a DataError"))).toBeNull();
    expect(mapPgError("nope")).toBeNull();
    expect(mapPgError(null)).toBeNull();
    expect(mapPgError(undefined)).toBeNull();
    expect(mapPgError({})).toBeNull();
  });
});
