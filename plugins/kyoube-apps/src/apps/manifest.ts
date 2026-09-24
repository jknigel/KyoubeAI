import { z } from "zod";
import { DataError } from "../data/errors.js";
import { assertIdentifier } from "../data/identifiers.js";

export const APP_SLUG_RE = /^[a-z][a-z0-9-]{1,48}$/;
export const MAX_APP_SOURCE_BYTES = 2 * 1024 * 1024;
/** Version notes are a short human record of a change, not a place to park text; every entry point caps them here. */
export const MAX_APP_NOTES = 2000;

export interface AppManifest {
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  tables: Array<{ name: string; access: "read" | "readwrite" }>;
  surfaces: Array<"page">;
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
  return { name: parsed.data.name, slug: parsed.data.slug, description: parsed.data.description ?? null, icon: parsed.data.icon ?? null, tables, surfaces: parsed.data.surfaces?.length ? parsed.data.surfaces : ["page"] };
}

export function assertAppSource(source: unknown): string {
  if (typeof source !== "string") throw new DataError("invalid", "app source must be a string");
  if (Buffer.byteLength(source, "utf8") > MAX_APP_SOURCE_BYTES) throw new DataError("limit", "app source must be at most 2 MiB");
  if (!/<(html|body|script)[\s>]/i.test(source)) throw new DataError("invalid", "app source must be an HTML document");
  return source;
}
