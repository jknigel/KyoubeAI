import { z } from "zod";
import { DataError } from "../data/errors.js";
import { assertIdentifier } from "../data/identifiers.js";
import { CONNECTION_NAME_RE } from "../connections/config.js";
import { canonical, questionKeySchema, questionsSchema, type Question } from "../decisions/contract.js";

export const APP_SLUG_RE = /^[a-z][a-z0-9-]{1,48}$/;
export const MAX_APP_SOURCE_BYTES = 2 * 1024 * 1024;
/** Version notes are a short human record of a change, not a place to park text; every entry point caps them here. */
export const MAX_APP_NOTES = 2000;

/** How many decision sets one app may declare, and how many fields one set may send. */
export const MAX_DECISION_SETS = 10;
export const MAX_DECISION_FIELDS = 20;
/** How many external API connections one app may declare. */
export const MAX_APP_CONNECTIONS = 10;

/**
 * One named set of typed questions an app may ask (docs/decisions.md). It is tied to one table the
 * manifest declares and the fields it may send: the worker builds the state from those fields and
 * nothing else, so an app can never send free text of its own or rewrite its questions at run time.
 */
export interface AppDecisionSet {
  table: string;
  fields: string[];
  /** Every answer is `review`: the set can only ever suggest. */
  advisory: boolean;
  questions: Record<string, Question>;
}

export interface AppManifest {
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  tables: Array<{ name: string; access: "read" | "readwrite" }>;
  surfaces: Array<"page">;
  /** Present only when the manifest declares at least one decision set. */
  decisions?: Record<string, AppDecisionSet>;
  /** Present only when the manifest declares at least one connection (docs/connections.md). */
  connections?: Array<{ name: string; access: "read" | "read-write" }>;
}

/**
 * The one description of a manifest's shape. `validateAppManifest` below is
 * still the authority (it also normalises and rejects duplicate or non-
 * identifier table names), but the tools and the REST routes reuse this schema
 * so an agent's declared parameters and a request body are checked — and, for
 * a tool, *documented* as JSON Schema — against exactly what is accepted here.
 */
export const APP_MANIFEST_SCHEMA = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().regex(APP_SLUG_RE, "slug must match ^[a-z][a-z0-9-]{1,48}$"),
  description: z.string().max(2000).nullable().optional(),
  icon: z.string().max(16).nullable().optional(),
  // .strict() on both this object and the table-entry object below: an unknown
  // key (a typo, or a field from a future manifest version) must be rejected
  // rather than silently dropped.
  tables: z.array(z.object({ name: z.string(), access: z.enum(["read", "readwrite"]).optional() }).strict()).max(50),
  surfaces: z.array(z.enum(["page"])).optional(),
  decisions: z.record(questionKeySchema, z.object({
    table: z.string(),
    fields: z.array(z.string()).min(1).max(MAX_DECISION_FIELDS),
    advisory: z.boolean().optional(),
    questions: questionsSchema,
  }).strict())
    .refine((sets) => Object.keys(sets).length <= MAX_DECISION_SETS, `at most ${MAX_DECISION_SETS} decision sets`)
    .optional()
    .describe("named sets of typed questions (docs/decisions.md): each names one declared table, the fields it may send, and its questions"),
  connections: z.array(z.object({ name: z.string().regex(CONNECTION_NAME_RE), access: z.enum(["read", "read-write"]).optional() }).strict())
    .max(MAX_APP_CONNECTIONS).optional()
    .describe("external API connections the app calls (docs/connections.md); a person confirms them at publish"),
}).strict();

export function validateAppManifest(raw: unknown): AppManifest {
  const parsed = APP_MANIFEST_SCHEMA.safeParse(raw);
  if (!parsed.success) throw new DataError("invalid", `invalid app manifest: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "manifest"} ${issue.message}`).join("; ")}`);
  const seen = new Set<string>();
  const tables = parsed.data.tables.map((table) => {
    const name = assertIdentifier(table.name, "app table");
    if (seen.has(name)) throw new DataError("invalid", `duplicate table "${name}" in app manifest`);
    seen.add(name);
    return { name, access: table.access ?? ("read" as const) };
  });
  const decisions = normaliseDecisionSets(parsed.data.decisions, new Set(tables.map((table) => table.name)));
  const connSeen = new Set<string>();
  const connections = (parsed.data.connections ?? []).map((entry) => {
    if (connSeen.has(entry.name)) throw new DataError("invalid", `duplicate connection "${entry.name}" in app manifest`);
    connSeen.add(entry.name);
    return { name: entry.name, access: entry.access ?? ("read" as const) };
  });
  return {
    name: parsed.data.name, slug: parsed.data.slug, description: parsed.data.description ?? null, icon: parsed.data.icon ?? null,
    tables, surfaces: parsed.data.surfaces?.length ? parsed.data.surfaces : ["page"],
    ...(decisions ? { decisions } : {}),
    ...(connections.length > 0 ? { connections } : {}),
  };
}

function normaliseDecisionSets(
  raw: Record<string, { table: string; fields: string[]; advisory?: boolean; questions: Record<string, Question> }> | undefined,
  declared: ReadonlySet<string>,
): Record<string, AppDecisionSet> | null {
  if (!raw || Object.keys(raw).length === 0) return null;
  const sets: Record<string, AppDecisionSet> = {};
  for (const [key, set] of Object.entries(raw)) {
    const table = assertIdentifier(set.table, `decision set "${key}" table`);
    if (!declared.has(table)) throw new DataError("invalid", `decision set "${key}" uses table "${table}", which the manifest does not declare`);
    const seen = new Set<string>();
    const fields = set.fields.map((name) => {
      const field = assertIdentifier(name, `decision set "${key}" field`);
      if (seen.has(field)) throw new DataError("invalid", `decision set "${key}" names field "${field}" twice`);
      seen.add(field);
      return field;
    });
    sets[key] = { table, fields, advisory: set.advisory ?? false, questions: set.questions };
  }
  return sets;
}

/**
 * Whether publishing `target` over `current` adds or changes what an app sends. A version with no
 * decision sets never counts — removing sets only ever narrows what leaves the server.
 */
export function decisionSetsChanged(current: AppManifest | null, target: AppManifest): boolean {
  const next = target.decisions ?? {};
  if (Object.keys(next).length === 0) return false;
  return JSON.stringify(canonical(current?.decisions ?? {})) !== JSON.stringify(canonical(next));
}

/**
 * Whether publishing `target` over `current` adds a connection the current version lacks, or widens
 * one from `read` to `read-write`. Removing or narrowing a connection never counts, and neither does
 * a reorder: those only shrink what the app can reach.
 */
export function connectionsChanged(current: AppManifest | null, target: AppManifest): boolean {
  const before = new Map((current?.connections ?? []).map((c) => [c.name, c.access]));
  return (target.connections ?? []).some((c) => {
    const was = before.get(c.name);
    return was === undefined || (was === "read" && c.access === "read-write");
  });
}

export function assertAppSource(source: unknown): string {
  if (typeof source !== "string") throw new DataError("invalid", "app source must be a string");
  if (Buffer.byteLength(source, "utf8") > MAX_APP_SOURCE_BYTES) throw new DataError("limit", "app source must be at most 2 MiB");
  if (!/<(html|body|script)[\s>]/i.test(source)) throw new DataError("invalid", "app source must be an HTML document");
  return source;
}
