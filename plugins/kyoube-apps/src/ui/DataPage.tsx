import { useCallback, useEffect, useMemo, useState } from "react";
import type { PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import { useHostContext, usePluginAction, usePluginData, usePluginToast } from "@paperclipai/plugin-sdk/ui";
import { errorText, formatCell, emptyRow, nextSelectedAfterDrop, resolveSelectedTable, type UiField, type UiTable } from "./format.js";
import { button, emptyFieldDraft, FieldEditor, fieldDraftToSpec, input, RowForm, type FieldDraft } from "./forms.js";

const PAGE_SIZE = 50;
type Row = Record<string, unknown>;

export function DataPage({ context }: PluginPageProps) {
  const host = useHostContext();
  const companyId = context.companyId ?? host.companyId ?? "";
  const toast = usePluginToast();
  // Ruling P2-R26: usePluginData re-fetches whenever its params object's
  // identity changes, so a fresh `{ companyId, userId }` literal every render
  // would poll forever. Memoise on the scalar inputs; data.access and
  // data.tables share the same scope, so one object serves both calls.
  const scopeParams = useMemo(() => ({ companyId, userId: host.userId }), [companyId, host.userId]);
  const access = usePluginData<{ level: string; hint: string }>("data.access", scopeParams);
  const tables = usePluginData<UiTable[]>("data.tables", scopeParams);
  const [selected, setSelected] = useState<string | null>(null);
  const table = useMemo(() => tables.data?.find((item) => item.name === selected) ?? null, [tables.data, selected]);
  const canWrite = access.data?.level === "write" || access.data?.level === "schema";
  const canSchema = access.data?.level === "schema";

  useEffect(() => {
    const next = resolveSelectedTable(tables.data ?? null, selected);
    if (next !== selected) setSelected(next);
  }, [tables.data, selected]);

  const notify = useCallback((title: string, tone: "success" | "error" = "success") => { toast({ title, tone }); }, [toast]);

  if (!companyId) return <div className="p-4 text-sm">Select a company.</div>;
  if (access.data && access.data.level === "none") return <div className="p-4 text-sm">You do not have access to this company's data. {access.data.hint}</div>;

  return (
    <div className="flex h-full gap-4 p-4" data-kyoube-page="data">
      <aside className="w-56 shrink-0">
        <div className="mb-2 flex items-center justify-between"><strong>Tables</strong>{canSchema && <CreateTableButton companyId={companyId} onCreated={(name) => { tables.refresh(); setSelected(name); notify(`Created ${name}`); }} />}</div>
        <ul className="space-y-1 text-sm">
          {(tables.data ?? []).map((item) => (
            <li key={item.name}><button type="button" className={`w-full rounded px-2 py-1 text-left ${item.name === selected ? "bg-accent" : "hover:bg-accent/50"}`} onClick={() => setSelected(item.name)}>{item.displayName} <span className="text-foreground/50">({item.name})</span></button></li>
          ))}
          {tables.data && tables.data.length === 0 && <li className="text-foreground/60">No tables yet.{canSchema ? " Create one, or ask an agent to." : ""}</li>}
        </ul>
      </aside>
      <main className="min-w-0 flex-1">
        {table ? <TableView key={table.name} companyId={companyId} userId={host.userId} table={table} allTables={(tables.data ?? []).map((item) => item.name)} canWrite={canWrite} canSchema={canSchema} onSchemaChange={() => tables.refresh()} onDropped={(droppedName) => { tables.refresh(); setSelected(nextSelectedAfterDrop(tables.data ?? null, droppedName)); }} notify={notify} /> : <div className="text-sm text-foreground/60">Select a table.</div>}
      </main>
    </div>
  );
}

function CreateTableButton(props: { companyId: string; onCreated: (name: string) => void }) {
  const createTable = usePluginAction("data.create_table");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [fields, setFields] = useState<FieldDraft[]>([emptyFieldDraft()]);
  const [error, setError] = useState<string | null>(null);
  if (!open) return <button type="button" className={button} onClick={() => setOpen(true)}>+ Table</button>;
  return (
    <form className="flex flex-col gap-2 rounded border p-2 text-sm" onSubmit={(event) => {
      event.preventDefault();
      createTable({ name: name.trim(), fields: fields.filter((field) => field.name.trim()).map(fieldDraftToSpec) })
        .then(() => { props.onCreated(name.trim()); setOpen(false); setName(""); setFields([emptyFieldDraft()]); })
        .catch((err) => setError(errorText(err)));
    }}>
      <input className={input} placeholder="table_name" value={name} onChange={(event) => setName(event.target.value)} />
      {fields.map((field, index) => <FieldEditor key={index} draft={field} tables={[]} onChange={(draft) => setFields((current) => current.map((item, i) => (i === index ? draft : item)))} />)}
      <button type="button" className={button} onClick={() => setFields((current) => [...current, emptyFieldDraft()])}>+ field</button>
      {error && <div className="text-red-600">{error}</div>}
      <div className="flex gap-2"><button type="submit" className={button}>Create</button><button type="button" className={button} onClick={() => setOpen(false)}>Cancel</button></div>
    </form>
  );
}

function TableView(props: { companyId: string; userId: string | null; table: UiTable; allTables: string[]; canWrite: boolean; canSchema: boolean; onSchemaChange: () => void; onDropped: (name: string) => void; notify: (title: string, tone?: "success" | "error") => void }) {
  const { companyId, table } = props;
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Row | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmDrop, setConfirmDrop] = useState(false);
  const [fieldDraft, setFieldDraft] = useState<FieldDraft | null>(null);
  const textFields = table.fields.filter((field) => ["text", "long_text", "email", "url", "select"].includes(field.kind));
  // Ruling P2-R26: memoise `where` on `search` and the text-field names (a
  // joined string, not the `textFields` array, so equal names compare equal
  // across renders even though `textFields` itself is a fresh array).
  const textFieldNames = textFields.map((field) => field.name).join(",");
  const where = useMemo(() => {
    const trimmed = search.trim();
    return trimmed && textFields.length > 0 ? { or: textFields.map((field) => ({ field: field.name, op: "contains", value: trimmed })) } : undefined;
  }, [search, textFieldNames]);
  const rowsParams = useMemo(
    () => ({ companyId, userId: props.userId, table: table.name, where, limit: PAGE_SIZE, offset: page * PAGE_SIZE, orderBy: [{ field: "created_at", direction: "desc" }] }),
    [companyId, props.userId, table.name, where, page],
  );
  const rows = usePluginData<{ rows: Row[] }>("data.rows", rowsParams);
  const countParams = useMemo(
    () => ({ companyId, userId: props.userId, table: table.name, where }),
    [companyId, props.userId, table.name, where],
  );
  const count = usePluginData<{ count: number }>("data.count", countParams);
  const insert = usePluginAction("data.insert");
  const update = usePluginAction("data.update");
  const remove = usePluginAction("data.delete");
  const addField = usePluginAction("data.add_field");
  const removeField = usePluginAction("data.remove_field");
  const dropTable = usePluginAction("data.drop_table");
  const refresh = () => { rows.refresh(); count.refresh(); };
  const run = (promise: Promise<unknown>, success: string) => promise.then(() => { props.notify(success); refresh(); }).catch((err) => props.notify(errorText(err), "error"));
  const total = count.data?.count ?? 0;
  const columns: Array<{ name: string; kind: UiField["kind"] | "system" }> = [...table.fields.map((field) => ({ name: field.name, kind: field.kind })), { name: "created_at", kind: "system" as const }];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">{table.displayName}</h2>
        <span className="text-xs text-foreground/60">{total} rows</span>
        <input className={input} placeholder="Search…" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} />
        <span className="flex-1" />
        {props.canWrite && <button type="button" className={button} onClick={() => setAdding(true)}>+ Row</button>}
        {props.canSchema && <button type="button" className={button} onClick={() => setFieldDraft(emptyFieldDraft())}>+ Field</button>}
        {props.canSchema && (confirmDrop
          ? <span className="flex items-center gap-1 text-sm">Drop {table.name}? <button type="button" className={button} onClick={() => { dropTable({ table: table.name }).then(() => { props.notify(`Dropped ${table.name} (recoverable for 30 days)`); props.onDropped(table.name); }).catch((err) => props.notify(errorText(err), "error")); }}>Yes</button><button type="button" className={button} onClick={() => setConfirmDrop(false)}>No</button></span>
          : <button type="button" className={button} onClick={() => setConfirmDrop(true)}>Drop table</button>)}
      </div>
      {fieldDraft && (
        <div className="flex flex-col gap-2 rounded border p-2">
          <FieldEditor draft={fieldDraft} tables={props.allTables} onChange={setFieldDraft} />
          <div className="flex gap-2"><button type="button" className={button} onClick={() => run(addField({ table: table.name, field: fieldDraftToSpec(fieldDraft) }).then(() => { setFieldDraft(null); props.onSchemaChange(); }), "Field added")}>Add</button><button type="button" className={button} onClick={() => setFieldDraft(null)}>Cancel</button></div>
        </div>
      )}
      {adding && <RowForm fields={table.fields} initial={emptyRow(table.fields)} submitLabel="Insert" onCancel={() => setAdding(false)} onSubmit={async (row) => { await insert({ table: table.name, rows: [row] }); setAdding(false); props.notify("Row inserted"); refresh(); }} />}
      {editing && <RowForm key={String(editing.id)} fields={table.fields} initial={editing} submitLabel="Save" onCancel={() => setEditing(null)} onSubmit={async (row) => { await update({ table: table.name, ids: [String(editing.id)], patch: row }); setEditing(null); props.notify("Row updated"); refresh(); }} />}
      <div className="overflow-x-auto rounded border">
        <table className="w-full text-sm">
          <thead><tr className="bg-accent/40 text-left">{columns.map((column) => <th key={column.name} className="px-2 py-1 font-medium">{column.name}{props.canSchema && column.kind !== "system" && <button type="button" className="ml-1 text-foreground/40 hover:text-red-600" title="Remove field" onClick={() => run(removeField({ table: table.name, field: column.name }).then(props.onSchemaChange), `Removed ${column.name}`)}>×</button>}</th>)}{props.canWrite && <th />}</tr></thead>
          <tbody>
            {(rows.data?.rows ?? []).map((row) => (
              <tr key={String(row.id)} className="border-t">
                {columns.map((column) => <td key={column.name} className="max-w-xs truncate px-2 py-1" title={formatCell(column.kind, row[column.name])}>{formatCell(column.kind, row[column.name])}</td>)}
                {props.canWrite && <td className="whitespace-nowrap px-2 py-1"><button type="button" className="underline" onClick={() => setEditing(row)}>edit</button> <button type="button" className="underline" onClick={() => run(remove({ table: table.name, ids: [String(row.id)] }), "Row deleted")}>delete</button></td>}
              </tr>
            ))}
            {rows.data && rows.data.rows.length === 0 && <tr><td className="px-2 py-3 text-foreground/60" colSpan={columns.length + 1}>No rows.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 text-xs">
        <button type="button" className={button} disabled={page === 0} onClick={() => setPage((value) => value - 1)}>Prev</button>
        <span>page {page + 1} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}</span>
        <button type="button" className={button} disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => setPage((value) => value + 1)}>Next</button>
        {rows.error && <span className="text-red-600">{rows.error.message}</span>}
      </div>
      {table.description && <p className="text-xs text-foreground/60">{table.description}</p>}
    </div>
  );
}
