import { useEffect, useState } from "react";
import { usePluginAction, usePluginToast } from "@paperclipai/plugin-sdk/ui";
import { errorText } from "./format.js";
import { input } from "./forms.js";

export interface DecisionSettingsViewData {
  settings: { agents: boolean; columns: boolean; apps: boolean; guardrail: boolean; dailyCap: number };
  provider: { configured: boolean; provider: string | null; model: string | null; keyResolves: boolean; problem: string | null };
  usage: { used: number; cap: number };
}

type Use = "agents" | "columns" | "apps" | "guardrail";
const USES: Array<{ key: Use; label: string; hint: string }> = [
  { key: "agents", label: "Agents", hint: "Agents ask typed questions over REST and the decisions_* tools." },
  { key: "columns", label: "AI columns", hint: "Data tables can have columns the model fills in." },
  { key: "apps", label: "Kyoube Apps", hint: "Published apps can call kyoube.decide on their declared fields." },
  { key: "guardrail", label: "Guardrail on risky agent actions", hint: "Dropping tables, bulk deletes and app publishing by agents are checked first; anything doubtful waits for a person." },
];

export function DecisionsSettingsView({ view, onChange }: { view: DecisionSettingsViewData; onChange: (patch: Partial<DecisionSettingsViewData["settings"]>) => void }) {
  const { provider, settings, usage } = view;
  return (
    <section className="flex max-w-3xl flex-col gap-2 rounded border p-3">
      <h2 className="text-sm font-semibold">Typed decisions</h2>
      {provider.configured ? (
        <p className="text-foreground/70">
          Provider <code>{provider.provider}</code>, model <code>{provider.model}</code>,{" "}
          {provider.keyResolves ? "key resolves" : "key does not resolve"}. {usage.used} of {usage.cap} requests used today (UTC).
        </p>
      ) : (
        <p className="text-foreground/70">No provider is set for this company. An instance admin sets the provider, model and API key secret under Settings → Plugins → Kyoube Data &amp; Apps, with this company selected.</p>
      )}
      {provider.problem && <p className="text-red-600">{provider.problem}</p>}
      <p className="text-foreground/70">Turning a use on sends that use's data to the provider above. Each switch covers one use.</p>
      {USES.map((use) => (
        <label key={use.key} className="flex items-start gap-2">
          <input type="checkbox" checked={settings[use.key]} onChange={(event) => onChange({ [use.key]: event.target.checked })} />
          <span><span className="font-medium">{use.label}</span> <span className="text-foreground/60">{use.hint}</span></span>
        </label>
      ))}
      <label className="flex items-center gap-2">Daily cap (provider requests per UTC day)
        <input className={input} type="number" min={0} defaultValue={settings.dailyCap} key={settings.dailyCap}
          onBlur={(event) => { const next = Number(event.target.value); if (Number.isInteger(next) && next >= 0 && next !== settings.dailyCap) onChange({ dailyCap: next }); }} />
      </label>
    </section>
  );
}

export function DecisionsSettings({ companyId }: { companyId: string }) {
  const toast = usePluginToast();
  const load = usePluginAction("decisions.settings");
  const save = usePluginAction("decisions.set_settings");
  const [view, setView] = useState<DecisionSettingsViewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () => load({}).then((result) => setView(result as DecisionSettingsViewData)).catch((err) => setError(errorText(err)));
  useEffect(() => { if (companyId) reload().catch(() => {}); }, [companyId]);
  if (error) return <div className="text-red-600">{error}</div>;
  if (!view) return null;
  return (
    <DecisionsSettingsView view={view} onChange={(patch) => {
      save(patch).then(() => { toast({ title: "Typed decisions updated", tone: "success" }); return reload(); }).catch((err) => toast({ title: errorText(err), tone: "error" }));
    }} />
  );
}
