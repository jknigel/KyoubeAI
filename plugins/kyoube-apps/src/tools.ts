import type { PluginContext, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { z } from "zod";
import { FIELD_KINDS } from "./data/field-kinds.js";
import { ACCESS_LEVELS } from "./data/permissions.js";
import type { DataService } from "./data/service.js";
import { declarationsFor, formatToolResult, registerToolHandlers, type ToolDefinition } from "./tool-runtime.js";

// Re-exported for callers (and Phase 2's tests) that formatted a tool result
// through this module before the runtime was shared with the Apps tools.
export { formatToolResult, type ToolDefinition };

const identifier = z.string().min(1).max(63).describe("lowercase snake_case name, e.g. contacts");
const fieldSpec = z.object({
  name: identifier,
  kind: z.enum(FIELD_KINDS).describe("text | long_text | integer | decimal | boolean | date | datetime | json | select | multi_select | relation | email | url"),
  displayName: z.string().optional(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  options: z.object({
    choices: z.array(z.string()).optional().describe("for select / multi_select"),
    relationTable: identifier.optional().describe("for relation: the table the field points to"),
  }).optional(),
});
const where = z.unknown().describe('filter: { field, op, value } with op in eq|neq|gt|gte|lt|lte|in|contains|starts_with|is_null|is_not_null, or { and: [...] } | { or: [...] } | { not: {...} }');
const rowTarget = { ids: z.array(z.string()).max(500).optional().describe("row ids (uuid), at most 500 per call"), where: where.optional() };

export const TOOL_DEFINITIONS: ToolDefinition<DataService>[] = [
  { name: "data_list_tables", displayName: "List tables", description: "List the organisation database tables in this company with their fields.", schema: z.object({}), run: (s, c, a) => s.listTables(c, a) },
  { name: "data_describe_table", displayName: "Describe table", description: "Show one table: fields, kinds, choices, relations, and system columns (id, created_at, updated_at).", schema: z.object({ table: identifier }), run: (s, c, a, p) => s.describeTable(c, a, p.table) },
  { name: "data_create_table", displayName: "Create table", description: "Create a table with typed fields. Every table automatically gets id (uuid), created_at, updated_at, created_by_kind, created_by_id. Requires schema access.", schema: z.object({ name: identifier, displayName: z.string().optional(), description: z.string().optional(), fields: z.array(fieldSpec).max(100) }), run: (s, c, a, p) => s.createTable(c, a, { name: p.name, displayName: p.displayName, description: p.description, fields: p.fields }) },
  { name: "data_add_field", displayName: "Add field", description: "Add a field (column) to an existing table. Requires schema access.", schema: z.object({ table: identifier, field: fieldSpec }), run: (s, c, a, p) => s.addField(c, a, p.table, p.field) },
  { name: "data_update_field", displayName: "Update field", description: "Change a field's display name, description, required flag, or choices (select/multi_select). Kinds cannot change. Requires schema access.", schema: z.object({ table: identifier, field: identifier, displayName: z.string().optional(), description: z.string().nullable().optional(), required: z.boolean().optional(), choices: z.array(z.string()).optional() }), run: (s, c, a, p) => s.updateField(c, a, p.table, p.field, { displayName: p.displayName, description: p.description, required: p.required, choices: p.choices }) },
  { name: "data_remove_field", displayName: "Remove field", description: "Remove a field. Recoverable for 30 days unless the company enabled hard deletes. Requires schema access.", schema: z.object({ table: identifier, field: identifier }), run: (s, c, a, p) => s.removeField(c, a, p.table, p.field) },
  { name: "data_drop_table", displayName: "Drop table", description: "Drop a table. Recoverable for 30 days unless the company enabled hard deletes. Requires schema access.", schema: z.object({ table: identifier }), run: (s, c, a, p) => s.dropTable(c, a, p.table) },
  { name: "data_rename_table", displayName: "Rename table", description: "Rename a table. Requires schema access.", schema: z.object({ table: identifier, newName: identifier }), run: (s, c, a, p) => s.renameTable(c, a, p.table, p.newName) },
  { name: "data_create_index", displayName: "Create index", description: "Create an index (optionally unique) on 1-4 fields of a table. Requires schema access.", schema: z.object({ table: identifier, fields: z.array(identifier).min(1).max(4), unique: z.boolean().optional() }), run: (s, c, a, p) => s.createIndex(c, a, p.table, p.fields, p.unique ?? false) },
  { name: "data_insert", displayName: "Insert rows", description: "Insert 1-500 rows, and at most 5000 bound values per call (one per field of the table, plus two per row), so a very wide table takes fewer rows at a time. Values are validated against field kinds (dates YYYY-MM-DD, select values from choices, relation = uuid of the target row). Returns the created rows. Requires write access.", schema: z.object({ table: identifier, rows: z.array(z.record(z.string(), z.unknown())).min(1).max(500) }), run: (s, c, a, p) => s.insert(c, a, p.table, p.rows) },
  { name: "data_update", displayName: "Update rows", description: "Update rows selected by ids or a where filter (exactly one; at most 500 ids). At most 1000 rows per call. Requires write access.", schema: z.object({ table: identifier, ...rowTarget, patch: z.record(z.string(), z.unknown()) }), run: (s, c, a, p) => s.update(c, a, p.table, { ids: p.ids, where: p.where }, p.patch) },
  { name: "data_delete", displayName: "Delete rows", description: "Delete rows selected by ids or a where filter (exactly one; at most 500 ids). At most 1000 rows per call. Requires write access.", schema: z.object({ table: identifier, ...rowTarget }), run: (s, c, a, p) => s.delete(c, a, p.table, { ids: p.ids, where: p.where }) },
  { name: "data_get", displayName: "Get row", description: "Fetch a single row from a table by its id.", schema: z.object({ table: identifier, id: z.string() }), run: (s, c, a, p) => s.get(c, a, p.table, p.id) },
  { name: "data_query", displayName: "Query rows", description: "Query rows with an optional where filter, orderBy, limit (max 1000, default 50), offset, and a field list.", schema: z.object({ table: identifier, where: where.optional(), orderBy: z.array(z.object({ field: z.string(), direction: z.enum(["asc", "desc"]).optional() })).optional(), limit: z.number().int().optional(), offset: z.number().int().optional(), fields: z.array(z.string()).optional() }), run: (s, c, a, p) => s.query(c, a, p.table, { where: p.where, orderBy: p.orderBy, limit: p.limit, offset: p.offset, fields: p.fields }) },
  { name: "data_count", displayName: "Count rows", description: "Count rows matching an optional where filter.", schema: z.object({ table: identifier, where: where.optional() }), run: async (s, c, a, p) => ({ count: await s.count(c, a, p.table, p.where) }) },
  { name: "data_sql_select", displayName: "Read-only SQL", description: "Run one read-only SELECT (joins, aggregates, CTEs allowed) over this company's own tables, written as bare names with no schema prefix. Postgres catalogs and other companies' tables are rejected; use data_describe_table to introspect. Only allowlisted functions may be called (common aggregate, string, math, date, JSON, array and window builtins) - no pg_* function, and no cast to a reg* type. Use $1, $2 placeholders with params. Max 1000 rows, 5 s.", schema: z.object({ sql: z.string().min(1).max(20_000), params: z.array(z.unknown()).max(50).optional() }), run: (s, c, a, p) => s.sqlSelect(c, a, p.sql, p.params ?? []) },
  { name: "data_my_access", displayName: "My data access", description: `Show your access level (${ACCESS_LEVELS.join(" < ")}) and how to request more.`, schema: z.object({}), run: (s, c, a) => s.myAccess(c, a) },
];

export const toolDeclarations = (): PluginToolDeclaration[] => declarationsFor(TOOL_DEFINITIONS);
export const registerTools = (ctx: PluginContext, service: DataService): void => registerToolHandlers(ctx, TOOL_DEFINITIONS, service);
