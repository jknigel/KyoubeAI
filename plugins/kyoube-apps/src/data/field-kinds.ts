import { z } from "zod";
import { DataError } from "./errors.js";
import { assertIdentifier, quoteIdent, quoteLiteral } from "./identifiers.js";

export const FIELD_KINDS = ["text", "long_text", "integer", "decimal", "boolean", "date", "datetime", "json", "select", "multi_select", "relation", "email", "url"] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export interface FieldOptions {
  choices?: string[];
  relationTable?: string;
}

export interface FieldSpec {
  name: string;
  displayName: string;
  description: string | null;
  kind: FieldKind;
  required: boolean;
  options: FieldOptions;
}

const fieldSchema = z.object({
  name: z.string(),
  displayName: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  kind: z.enum(FIELD_KINDS),
  required: z.boolean().optional(),
  options: z.object({
    choices: z.array(z.string().trim().min(1).max(120)).max(200).optional(),
    relationTable: z.string().optional(),
  }).optional(),
});

function titleCase(name: string): string {
  return name.split("_").filter(Boolean).map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ");
}

export function normalizeFieldSpec(raw: unknown): FieldSpec {
  const parsed = fieldSchema.safeParse(raw);
  if (!parsed.success) throw new DataError("invalid", `invalid field: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "field"} ${issue.message}`).join("; ")}`);
  const value = parsed.data;
  const name = assertIdentifier(value.name, "field name");
  const options: FieldOptions = {};
  if (value.kind === "select" || value.kind === "multi_select") {
    const choices = [...new Set(value.options?.choices ?? [])];
    if (choices.length === 0) throw new DataError("invalid", `field "${name}" of kind ${value.kind} needs options.choices`);
    options.choices = choices;
  }
  if (value.kind === "relation") {
    if (!value.options?.relationTable) throw new DataError("invalid", `field "${name}" of kind relation needs options.relationTable`);
    options.relationTable = assertIdentifier(value.options.relationTable, "relationTable");
  }
  return { name, displayName: value.displayName ?? titleCase(name), description: value.description ?? null, kind: value.kind, required: value.required ?? false, options };
}

export function columnType(kind: FieldKind): string {
  switch (kind) {
    case "text": case "long_text": case "select": case "email": case "url": return "text";
    case "integer": return "bigint";
    case "decimal": return "numeric";
    case "boolean": return "boolean";
    case "date": return "date";
    case "datetime": return "timestamptz";
    case "json": return "jsonb";
    case "multi_select": return "text[]";
    case "relation": return "uuid";
  }
}

export function choicesConstraintName(table: string, field: string): string {
  return `${table}_${field}_choices`.slice(0, 63);
}

export function choicesConstraint(spec: FieldSpec, table: string): string | null {
  if (!spec.options.choices) return null;
  const literals = spec.options.choices.map(quoteLiteral).join(", ");
  const column = quoteIdent(spec.name);
  const body = spec.kind === "multi_select" ? `${column} <@ ARRAY[${literals}]::text[]` : `${column} IN (${literals})`;
  return `CONSTRAINT ${quoteIdent(choicesConstraintName(table, spec.name))} CHECK (${body})`;
}

export function columnDefinition(spec: FieldSpec, table: string): string {
  const parts = [quoteIdent(spec.name), columnType(spec.kind)];
  if (spec.required) parts.push("NOT NULL");
  const constraint = choicesConstraint(spec, table);
  if (constraint) parts.push(constraint);
  if (spec.kind === "relation" && spec.options.relationTable) parts.push(`REFERENCES ${quoteIdent(spec.options.relationTable)} ("id") ON DELETE SET NULL`);
  return parts.join(" ");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function coerceValue(spec: FieldSpec, value: unknown): unknown {
  if (value === null || value === undefined || value === "") {
    if (spec.required) throw new DataError("invalid", `field "${spec.name}" is required`);
    return null;
  }
  const fail = (expected: string): never => { throw new DataError("invalid", `field "${spec.name}" expects ${expected}`); };
  switch (spec.kind) {
    case "text": case "long_text":
      if (typeof value === "string") return value;
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      return fail("text");
    case "integer": {
      if (typeof value === "number") {
        return Number.isInteger(value) ? value : fail("an integer");
      }
      if (typeof value === "string" && value.trim().length > 0) {
        const n = Number(value.trim());
        return Number.isInteger(n) ? n : fail("an integer");
      }
      return fail("an integer");
    }
    case "decimal": {
      if (typeof value === "number") {
        return Number.isFinite(value) ? value : fail("a number");
      }
      if (typeof value === "string" && value.trim().length > 0) {
        const n = Number(value.trim());
        return Number.isFinite(n) ? n : fail("a number");
      }
      return fail("a number");
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      if (value === "true" || value === "false") return value === "true";
      return fail("a boolean");
    case "date":
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) ? value : fail("a date formatted YYYY-MM-DD");
    case "datetime": {
      const ms = typeof value === "string" || typeof value === "number" ? Date.parse(String(value)) : Number.NaN;
      return Number.isNaN(ms) ? fail("an ISO 8601 timestamp") : new Date(ms).toISOString();
    }
    case "json": return value;
    case "select":
      return typeof value === "string" && spec.options.choices?.includes(value) ? value : fail(`one of ${spec.options.choices?.join(", ")}`);
    case "multi_select":
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && spec.options.choices?.includes(item))) return fail(`an array with values from ${spec.options.choices?.join(", ")}`);
      return value;
    case "relation":
      return typeof value === "string" && UUID_RE.test(value) ? value.toLowerCase() : fail("a record id (uuid)");
    case "email":
      return typeof value === "string" && EMAIL_RE.test(value) ? value.trim() : fail("an email address");
    case "url":
      if (typeof value !== "string") return fail("a URL");
      try { return new URL(value).toString(); } catch { return fail("a URL"); }
  }
}
