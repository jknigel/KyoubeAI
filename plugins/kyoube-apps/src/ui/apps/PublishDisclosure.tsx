// src/ui/apps/PublishDisclosure.tsx
import { Fragment, useState } from "react";
import { usePluginAction, usePluginToast } from "@paperclipai/plugin-sdk/ui";
import { errorText } from "../format.js";
import { button } from "../forms.js";

/** What `apps.publish_preview` returns (`PublishPreview` in src/apps/service.ts). */
export interface PublishPreviewData {
  version: number;
  changed: boolean;
  provider: string | null;
  available: boolean;
  /** Absent from an older worker; treated as no connections. */
  connections?: { changed: boolean; list: PublishConnection[] };
  sets: Array<{ key: string; table: string; fields: string[]; advisory: boolean; questions: Array<{ key: string; type: string; text: string }> }>;
}

export interface PublishConnection { name: string; access: "read" | "read-write"; baseUrl: string | null; auth: string | null; methods: string | null; available: boolean; missing: boolean }

export const connectionsOf = (preview: PublishPreviewData): PublishConnection[] => preview.connections?.list ?? [];
export const connectionsChanged = (preview: PublishPreviewData): boolean => connectionsOf(preview).length > 0 && preview.connections?.changed === true;

const PROVIDER_NAMES: Record<string, string> = {
  typesafe: "TypeSafe",
  openrouter: "OpenRouter",
  vercel: "Vercel AI Gateway",
  custom: "the company's custom decisions provider",
};

export function providerName(provider: string | null): string {
  return provider ? PROVIDER_NAMES[provider] ?? provider : "the company's decisions provider (none is set yet)";
}

export function sentFields(set: PublishPreviewData["sets"][number]): string[] {
  return set.fields.map((field) => `${set.table}.${field}`);
}

/**
 * Spec §5: the publish dialog says plainly what leaves the server, and a person confirms that no
 * set decides anything about people's lives unless it is advisory. Pure, so the unit suite can
 * render it without a host.
 */
export function PublishDisclosure(props: { preview: PublishPreviewData; appName: string; confirmed: boolean; onConfirmedChange: (next: boolean) => void; connectionsConfirmed?: boolean; onConnectionsConfirmedChange?: (next: boolean) => void }) {
  const { preview, appName } = props;
  const connections = connectionsOf(preview);
  const provider = providerName(preview.provider);
  return (
    <div className="flex flex-col gap-2">
      {preview.sets.map((set) => (
        <section key={set.key} className="rounded border p-2">
          <div className="font-medium">Decision set <code>{set.key}</code>{set.advisory && <span className="text-foreground/60"> (advisory: every answer is only a suggestion)</span>}</div>
          <p>
            Sends {sentFields(set).map((field, index) => <Fragment key={field}>{index > 0 ? ", " : ""}<code>{field}</code></Fragment>)} to {provider} each time someone uses {appName}.
          </p>
          <ul className="list-disc pl-5 text-foreground/80">
            {set.questions.map((question) => <li key={question.key}><code>{question.key}</code> ({question.type}): {question.text}</li>)}
          </ul>
        </section>
      ))}
      {connections.length > 0 && (
        <section className="rounded border p-2" data-kyoube-connections="">
          <div className="font-medium">Connections</div>
          <ul className="list-disc pl-5">
            {connections.map((entry) => (
              <li key={entry.name} className={preview.connections?.changed ? "font-medium" : undefined}>
                <code>{entry.name}</code> ({entry.access}){entry.baseUrl && <> <span className="break-all" data-kyoube-break="">{entry.baseUrl.replace(/^https?:\/\//, "")}</span></>}
                {entry.missing ? <span className="text-red-600"> — not set up; ask a company admin</span> : !entry.available ? <span className="text-red-600"> — its secret doesn't resolve</span> : null}
              </li>
            ))}
          </ul>
          {preview.connections?.changed && (
            <>
              <p className="text-foreground/70">This version adds or widens connections, so it needs a person to publish it. Agents cannot.</p>
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={props.connectionsConfirmed === true} onChange={(event) => props.onConnectionsConfirmedChange?.(event.target.checked)} />
                <span>This app may call these services with the company's credentials</span>
              </label>
            </>
          )}
        </section>
      )}
      {!preview.available && <p className="text-foreground/70">Typed decisions for apps are switched off for this company or no provider is set, so these sets will answer <code>disabled</code> until a company admin turns them on under Company Settings → Data access.</p>}
      {preview.changed && (
        <>
          <p className="text-foreground/70">This version adds or changes decision sets, so it needs a person to publish it. Agents cannot.</p>
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={props.confirmed} onChange={(event) => props.onConfirmedChange(event.target.checked)} />
            <span>No decision set here decides anything about a person's employment, credit, housing, health, education or legal status. A set that does is marked advisory.</span>
          </label>
        </>
      )}
    </div>
  );
}

/**
 * The dialog around the disclosure: publishes or rolls back once the person has confirmed. It always
 * names the version the disclosure was built from, never "latest", so a draft saved while the dialog
 * is open cannot be published under this confirmation. The tick belongs to one mode and version: shown
 * anything else, the dialog asks again.
 */
export function PublishDialog(props: { slug: string; appName: string; mode: "publish" | "rollback"; preview: PublishPreviewData; onDone: () => void; onCancel: () => void }) {
  const toast = usePluginToast();
  const publish = usePluginAction("apps.publish");
  const rollback = usePluginAction("apps.rollback");
  const shown = `${props.mode}:${props.preview.version}`;
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);
  const confirmed = confirmedFor === shown;
  const [connectionsFor, setConnectionsFor] = useState<string | null>(null);
  const connectionsConfirmed = connectionsFor === shown;
  const needsConnections = connectionsChanged(props.preview);
  const [busy, setBusy] = useState(false);
  const ready = (!props.preview.changed || confirmed) && (!needsConnections || connectionsConfirmed);
  const go = () => {
    setBusy(true);
    const params = { slug: props.slug, version: props.preview.version, decisionsConfirmed: props.preview.changed && confirmed, ...(needsConnections && connectionsConfirmed ? { connectionsConfirmed: true } : {}) };
    (props.mode === "publish" ? publish(params) : rollback(params))
      .then(() => { toast({ title: props.mode === "publish" ? `Published v${props.preview.version}` : "Rolled back", tone: "success" }); props.onDone(); })
      .catch((err: unknown) => { toast({ title: errorText(err), tone: "error" }); })
      .finally(() => setBusy(false));
  };
  return (
    <div className="flex flex-col gap-2 rounded border p-3 text-sm">
      <div className="font-medium">{props.mode === "publish" ? `Publish version ${props.preview.version}?` : `Roll back to version ${props.preview.version}?`}</div>
      <PublishDisclosure preview={props.preview} appName={props.appName} confirmed={confirmed} onConfirmedChange={(next) => setConfirmedFor(next ? shown : null)} connectionsConfirmed={connectionsConfirmed} onConnectionsConfirmedChange={(next) => setConnectionsFor(next ? shown : null)} />
      <div className="flex gap-2">
        <button type="button" className={button} disabled={!ready || busy} onClick={go}>{props.mode === "publish" ? "Publish" : "Roll back"}</button>
        <button type="button" className={button} onClick={props.onCancel}>Cancel</button>
      </div>
    </div>
  );
}
