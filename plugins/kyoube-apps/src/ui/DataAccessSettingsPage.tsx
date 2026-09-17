import { useEffect, useState } from "react";
import type { PluginCompanySettingsPageProps } from "@paperclipai/plugin-sdk/ui";
import { usePluginAction, usePluginToast } from "@paperclipai/plugin-sdk/ui";
import { errorText } from "./format.js";
import { button, input } from "./forms.js";

const LEVELS = ["none", "read", "write", "schema"] as const;
interface GrantsData { settings: { defaultAgentLevel: string; hardDelete: boolean }; grants: Array<{ agentId: string; level: string; updatedAt: string }>; agents: Array<{ id: string; name: string; status: string }> }

export function DataAccessSettingsPage({ context }: PluginCompanySettingsPageProps) {
  const companyId = context.companyId ?? "";
  const toast = usePluginToast();
  const loadGrants = usePluginAction("data.grants");
  const setGrant = usePluginAction("data.set_agent_grant");
  const setSettings = usePluginAction("data.set_settings");
  const setupCompany = usePluginAction("data.setup_company");
  const [data, setData] = useState<GrantsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () => loadGrants({}).then((result) => setData(result as GrantsData)).catch((err) => setError(errorText(err)));
  useEffect(() => { if (companyId) reload().catch(() => {}); }, [companyId]);
  const act = (promise: Promise<unknown>, title: string) => promise.then(() => { toast({ title, tone: "success" }); return reload(); }).catch((err) => toast({ title: errorText(err), tone: "error" }));

  return (
    <div className="flex flex-col gap-4 p-4 text-sm">
      <h1 className="text-base font-semibold">Data access</h1>
      <p className="text-foreground/70">Levels: <code>none</code> &lt; <code>read</code> &lt; <code>write</code> &lt; <code>schema</code>. People get their level from their company role (viewer → read, member/operator → write, owner/admin → schema). Agents get an explicit level or the company default.</p>
      {error && <div className="text-red-600">{error}</div>}
      {data && (
        <>
          <section className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2">Default level for agents
              <select className={input} value={data.settings.defaultAgentLevel} onChange={(event) => act(setSettings({ defaultAgentLevel: event.target.value }), "Default updated")}>
                {LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={data.settings.hardDelete} onChange={(event) => act(setSettings({ hardDelete: event.target.checked }), "Delete mode updated")} /> Hard-delete dropped tables and fields immediately (default: keep 30 days)</label>
            <button type="button" className={button} onClick={() => act(setupCompany({}), "Kyoube Data skill installed for this company")}>Install the Kyoube Data skill</button>
          </section>
          <table className="w-full max-w-3xl text-sm">
            <thead><tr className="bg-accent/40 text-left"><th className="px-2 py-1">Agent</th><th className="px-2 py-1">Status</th><th className="px-2 py-1">Data level</th></tr></thead>
            <tbody>
              {data.agents.map((agent) => (
                <tr key={agent.id} className="border-t">
                  <td className="px-2 py-1">{agent.name}</td>
                  <td className="px-2 py-1 text-foreground/60">{agent.status}</td>
                  <td className="px-2 py-1">
                    <select className={input} value={data.grants.find((grant) => grant.agentId === agent.id)?.level ?? ""} onChange={(event) => act(setGrant({ agentId: agent.id, level: event.target.value || data.settings.defaultAgentLevel }), `${agent.name} → ${event.target.value || "default"}`)}>
                      {/* Choosing this option writes data.settings.defaultAgentLevel as an explicit grant (there is
                          no "clear grant" action), so the label must show that value, not the agent's own current
                          level — labelling it with the agent's level would misrepresent a default-pin as a no-op. */}
                      <option value="">use default ({data.settings.defaultAgentLevel})</option>
                      {LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
              {data.agents.length === 0 && <tr><td className="px-2 py-2 text-foreground/60" colSpan={3}>No agents in this company yet.</td></tr>}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
