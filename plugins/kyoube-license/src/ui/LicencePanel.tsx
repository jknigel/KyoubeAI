import type { LicenceStatusAnswer, LicenceView } from "../shared.js";

export interface LicencePanelProps {
  answer: LicenceStatusAnswer | null;
  error: string | null;
  keyText: string;
  busy: boolean;
  notice: string | null;
  onKeyText(text: string): void;
  onApply(): void;
  onClear(): void;
  /** `useHostNavigation().linkProps("/terminal")`, so the link stays inside the app. */
  terminalLinkProps: Record<string, unknown>;
}

function copy(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {});
}

function tone(view: LicenceView): string {
  const { status } = view;
  if (status.overLimit || status.state === "expired" || status.state === "invalid") return "border-red-500/50 bg-red-500/10";
  if (status.atLimit || status.expiringSoon) return "border-amber-500/50 bg-amber-500/10";
  return "border-border bg-card";
}

function StatusCard({ view }: { view: LicenceView }) {
  const { status } = view;
  return (
    <section className={`rounded-lg border p-4 ${tone(view)}`} aria-label="Licence status">
      <div className="text-base font-semibold">{status.summary}</div>
      {status.problem && <p className="mt-1 text-sm">{status.problem}</p>}
      {status.expiringSoon && status.daysLeft !== null && <p className="mt-1 text-sm">The licence expires in {status.daysLeft} {status.daysLeft === 1 ? "day" : "days"}. After that the free limit of 5 users applies.</p>}
      {status.overLimit && <p className="mt-1 text-sm">More users than the licence allows. Everyone keeps working, but no one new can be added.</p>}
      {!status.overLimit && status.atLimit && <p className="mt-1 text-sm">At the user limit: the next sign-up is refused.</p>}
      {status.licenceId && <p className="mt-2 text-xs text-foreground/60">Licence {status.licenceId} · {status.instanceBound ? "this instance only" : "any instance"}</p>}
      <p className="mt-2 text-xs text-foreground/60">User count as of {new Date(view.snapshotAt).toLocaleString()}.</p>
    </section>
  );
}

export function LicencePanel(props: LicencePanelProps) {
  const { answer } = props;
  if (answer === null) return <div className="p-4 text-sm text-foreground/70">{props.error ?? "Loading the licence…"}</div>;
  if (!answer.visible) {
    return (
      <div className="p-4 text-sm text-foreground/70">
        {answer.reason === "not_admin" ? "Only instance admins can see the licence." : "KyoubeAI is still reading the user list. This takes up to a minute after a restart."}
      </div>
    );
  }
  const view = answer;
  return (
    <div className="flex max-w-3xl flex-col gap-5 p-4">
      <StatusCard view={view} />

      <section aria-label="Licence key" className="flex flex-col gap-2">
        <label className="text-sm font-semibold" htmlFor="kyoube-licence-key">Licence key</label>
        <textarea
          id="kyoube-licence-key"
          className="min-h-20 rounded-md border border-border bg-background p-2 font-mono text-xs"
          placeholder="KYB1.…"
          value={props.keyText}
          onChange={(event) => props.onKeyText(event.target.value)}
          spellCheck={false}
        />
        <div className="flex gap-2">
          <button type="button" className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50" disabled={props.busy || props.keyText.trim().length === 0} onClick={props.onApply}>Apply</button>
          {view.status.verify !== null && (
            <button type="button" className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50" disabled={props.busy} onClick={props.onClear}>Remove licence</button>
          )}
        </div>
        {props.error && <p className="text-sm text-red-600" role="alert">{props.error}</p>}
        {props.notice && <p className="text-sm text-green-700" role="status">{props.notice}</p>}
      </section>

      <section aria-label="Instance ID" className="flex items-center gap-2 text-sm">
        <span className="font-semibold">Instance ID</span>
        <code className="rounded bg-accent px-1.5 py-0.5 text-xs">{view.instanceId ?? "not created yet"}</code>
        {view.instanceId && <button type="button" className="rounded px-2 py-0.5 text-xs hover:bg-accent" onClick={() => copy(view.instanceId!)}>Copy</button>}
        <span className="text-xs text-foreground/60">Send this to KyoubeAI for a key that works on this instance only.</span>
      </section>

      <section aria-label="Users" className="flex flex-col gap-1">
        <div className="text-sm font-semibold">Users ({view.users.length} counted)</div>
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {view.users.map((user) => (
            <li key={user.id} className="flex flex-col gap-1 p-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium">{user.name}</span>
                <span className="text-foreground/60">{user.email}</span>
                {user.isInstanceAdmin && <span className="rounded bg-accent px-1.5 text-xs">instance admin</span>}
                <span className="ml-auto text-xs text-foreground/60">since {user.createdAt.slice(0, 10)}</span>
              </div>
              <details className="text-xs">
                <summary className="cursor-pointer text-foreground/70">Remove</summary>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span>Run this in the</span>
                  <a {...props.terminalLinkProps} className="underline">Terminal</a>
                  <span>to delete the account and free its seat:</span>
                  <code className="rounded bg-accent px-1.5 py-0.5">{user.removeCommand}</code>
                  <button type="button" className="rounded px-2 py-0.5 hover:bg-accent" onClick={() => copy(user.removeCommand)}>Copy</button>
                </div>
              </details>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
