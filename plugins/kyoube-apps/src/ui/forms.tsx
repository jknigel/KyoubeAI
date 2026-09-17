import { useState } from "react";
import { initialFormValue, parseCellInput, type UiField, type UiFieldKind } from "./format.js";

const KINDS: UiFieldKind[] = ["text", "long_text", "integer", "decimal", "boolean", "date", "datetime", "json", "select", "multi_select", "relation", "email", "url"];
export const input = "rounded border px-2 py-1 text-sm bg-background";
export const button = "rounded border px-2 py-1 text-sm hover:bg-accent";

/** One input per field kind; values are kept as strings until submit. */
export function CellInput(props: { field: UiField; value: string; onChange: (value: string) => void }) {
  const { field, value, onChange } = props;
  if (field.kind === "boolean") return <input type="checkbox" checked={value === "true"} onChange={(event) => onChange(event.target.checked ? "true" : "false")} />;
  if (field.kind === "select") return (
    <select className={input} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">—</option>
      {(field.options.choices ?? []).map((choice) => <option key={choice} value={choice}>{choice}</option>)}
    </select>
  );
  if (field.kind === "long_text" || field.kind === "json") return <textarea className={input} rows={3} value={value} onChange={(event) => onChange(event.target.value)} />;
  const type = field.kind === "date" ? "date" : field.kind === "datetime" ? "datetime-local" : field.kind === "integer" || field.kind === "decimal" ? "number" : "text";
  return <input className={input} type={type} value={value} placeholder={field.kind === "multi_select" ? "a, b" : field.kind === "relation" ? "row id" : ""} onChange={(event) => onChange(event.target.value)} />;
}

export function RowForm(props: { fields: UiField[]; initial: Record<string, unknown>; submitLabel: string; onSubmit: (row: Record<string, unknown>) => Promise<void>; onCancel: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(props.fields.map((field) => [field.name, initialFormValue(field, props.initial[field.name])])));
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="flex flex-col gap-2 rounded border p-3" onSubmit={(event) => {
      event.preventDefault();
      try {
        const row: Record<string, unknown> = {};
        for (const field of props.fields) row[field.name] = parseCellInput(field.kind, values[field.name] ?? "");
        props.onSubmit(row).catch((err) => setError(String(err instanceof Error ? err.message : err)));
      } catch (err) { setError(String(err instanceof Error ? err.message : err)); }
    }}>
      {props.fields.map((field) => (
        <label key={field.name} className="flex items-center gap-2 text-sm">
          <span className="w-40 shrink-0">{field.displayName}{field.required ? " *" : ""}</span>
          <CellInput field={field} value={values[field.name] ?? ""} onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))} />
        </label>
      ))}
      {error && <div className="text-sm text-red-600">{error}</div>}
      <div className="flex gap-2"><button type="submit" className={button}>{props.submitLabel}</button><button type="button" className={button} onClick={props.onCancel}>Cancel</button></div>
    </form>
  );
}

export interface FieldDraft { name: string; kind: UiFieldKind; required: boolean; choices: string; relationTable: string }
export const emptyFieldDraft = (): FieldDraft => ({ name: "", kind: "text", required: false, choices: "", relationTable: "" });

export function fieldDraftToSpec(draft: FieldDraft) {
  return {
    name: draft.name.trim(),
    kind: draft.kind,
    required: draft.required,
    options: {
      ...(draft.kind === "select" || draft.kind === "multi_select" ? { choices: draft.choices.split(",").map((item) => item.trim()).filter(Boolean) } : {}),
      ...(draft.kind === "relation" ? { relationTable: draft.relationTable.trim() } : {}),
    },
  };
}

export function FieldEditor(props: { draft: FieldDraft; tables: string[]; onChange: (draft: FieldDraft) => void }) {
  const { draft, onChange } = props;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <input className={input} placeholder="field_name" value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} />
      <select className={input} value={draft.kind} onChange={(event) => onChange({ ...draft, kind: event.target.value as UiFieldKind })}>
        {KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
      </select>
      <label className="flex items-center gap-1"><input type="checkbox" checked={draft.required} onChange={(event) => onChange({ ...draft, required: event.target.checked })} /> required</label>
      {(draft.kind === "select" || draft.kind === "multi_select") && <input className={input} placeholder="choice1, choice2" value={draft.choices} onChange={(event) => onChange({ ...draft, choices: event.target.value })} />}
      {draft.kind === "relation" && (
        <select className={input} value={draft.relationTable} onChange={(event) => onChange({ ...draft, relationTable: event.target.value })}>
          <option value="">target table…</option>
          {props.tables.map((table) => <option key={table} value={table}>{table}</option>)}
        </select>
      )}
    </div>
  );
}
