// src/ui/AiColumns.tsx
import { input } from "./forms.js";
import type { UiAiColumn, UiField, UiQuestion } from "./format.js";

export interface UiCellCounts { auto: number; review: number; manual: number; error: number }

export function sendsText(field: UiField, provider: string | null): string {
  const sources = field.options.decision?.sourceFields.join(", ") ?? "";
  return `Sends ${sources} to ${provider ?? "the company's provider"}`;
}

export function percent(confidence: number | null): string {
  return confidence === null ? "?" : `${Math.round(confidence * 100)}%`;
}

/** The stored suggestion is text; a boolean column needs it back as true/false. */
export function suggestionValue(field: UiField, suggestion: string): unknown {
  return field.kind === "boolean" ? suggestion === "true" : suggestion;
}

export function AiColumnHeader(props: { field: UiField; provider: string | null; counts: UiCellCounts | null; canSchema: boolean; onRefill: () => void }) {
  const review = props.counts?.review ?? 0;
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span><span className="rounded bg-accent px-1 text-[10px] font-semibold" title={sendsText(props.field, props.provider)}>AI</span> {props.field.name}</span>
      <span className="text-[11px] font-normal text-foreground/60">{sendsText(props.field, props.provider)}</span>
      <span className="text-[11px] font-normal">
        {review > 0 && <span className="text-amber-700">{review} to review </span>}
        {props.canSchema && <button type="button" className="underline" onClick={props.onRefill}>Refill</button>}
      </span>
    </span>
  );
}

/**
 * Whether Accept can write the suggestion as it stands: `true`/`false` for a check, one of the
 * column's choices otherwise. `unsure` is never a choice, so it only ever offers Change.
 */
export function acceptable(field: UiField, suggestion: string): boolean {
  if (field.kind === "boolean") return suggestion === "true" || suggestion === "false";
  return (field.options.choices ?? []).includes(suggestion);
}

export function ReviewCell(props: { suggestion: string; confidence: number | null; canWrite: boolean; canAccept: boolean; onAccept: () => void; onChange: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 text-amber-800">
      Suggested: {props.suggestion} ({percent(props.confidence)})
      {props.canWrite && <>{props.canAccept && <button type="button" className="underline" onClick={props.onAccept}>Accept</button>}<button type="button" className="underline" onClick={props.onChange}>Change</button></>}
    </span>
  );
}

export interface AiColumnDraft { name: string; type: UiQuestion["type"]; text: string; options: string; sources: string[]; review: string; advisory: boolean }
export const emptyAiColumnDraft = (): AiColumnDraft => ({ name: "", type: "choice", text: "", options: "", sources: [], review: "", advisory: false });

/** Choices: one per line, `key: description` or just `key`. Levels: one per line, low to high. */
export function aiDraftToSpec(draft: AiColumnDraft): { name: string; kind: "select" | "boolean"; options: { decision: UiAiColumn } } {
  const lines = draft.options.split("\n").map((line) => line.trim()).filter(Boolean);
  const review = draft.review.trim() === "" ? undefined : Number(draft.review);
  const withReview = <Q extends UiQuestion>(question: Q): Q => (review === undefined ? question : { ...question, review });
  let question: UiQuestion;
  if (draft.type === "choice") {
    const options: Record<string, string | null> = {};
    for (const line of lines) {
      const at = line.indexOf(":");
      if (at === -1) options[line] = null;
      else options[line.slice(0, at).trim()] = line.slice(at + 1).trim() || null;
    }
    question = withReview({ type: "choice", instructions: draft.text.trim(), options });
  } else if (draft.type === "score") {
    question = withReview({ type: "score", instructions: draft.text.trim(), levels: lines });
  } else {
    question = withReview({ type: "check", statement: draft.text.trim() });
  }
  return {
    name: draft.name.trim(),
    kind: draft.type === "check" ? "boolean" : "select",
    options: { decision: { question, sourceFields: draft.sources, ...(draft.advisory ? { advisory: true } : {}) } },
  };
}

export function AiColumnEditor(props: { draft: AiColumnDraft; fields: UiField[]; onChange: (draft: AiColumnDraft) => void }) {
  const { draft, onChange } = props;
  const sources = props.fields.filter((field) => field.kind !== "relation" && !field.options.decision);
  const toggle = (name: string, on: boolean) => onChange({ ...draft, sources: on ? [...draft.sources, name] : draft.sources.filter((source) => source !== name) });
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <input className={input} placeholder="field_name" value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} />
        <select className={input} value={draft.type} onChange={(event) => onChange({ ...draft, type: event.target.value as AiColumnDraft["type"] })}>
          <option value="choice">choice (one option)</option>
          <option value="score">score (levels, low to high)</option>
          <option value="check">check (yes or no)</option>
        </select>
        <label className="flex items-center gap-1"><input type="checkbox" checked={draft.advisory} onChange={(event) => onChange({ ...draft, advisory: event.target.checked })} /> advisory (always a suggestion)</label>
        <input className={input} placeholder="review below (0.9)" value={draft.review} onChange={(event) => onChange({ ...draft, review: event.target.value })} />
      </div>
      <textarea className={input} rows={2} placeholder={draft.type === "check" ? "Statement, e.g. The ticket asks for a refund." : "Question, e.g. Which team owns this ticket?"} value={draft.text} onChange={(event) => onChange({ ...draft, text: event.target.value })} />
      {draft.type !== "check" && <textarea className={input} rows={4} placeholder={draft.type === "choice" ? "one option per line, e.g.\nbilling: Payments and refunds\ntechnical" : "one level per line, low to high"} value={draft.options} onChange={(event) => onChange({ ...draft, options: event.target.value })} />}
      <div className="flex flex-wrap items-center gap-2">Reads:
        {sources.map((field) => <label key={field.name} className="flex items-center gap-1"><input type="checkbox" checked={draft.sources.includes(field.name)} onChange={(event) => toggle(field.name, event.target.checked)} />{field.name}</label>)}
      </div>
      <p className="text-xs text-foreground/60">The fields it reads are sent to the company's typed-decision provider for every row.</p>
    </div>
  );
}

/** AI cells change only through Accept/Change; a whole-row form would write every AI value back. */
export function rowFormFields(fields: UiField[]): UiField[] {
  return fields.filter((field) => !field.options.decision);
}
