import { useEffect, useState } from "react";
import { usePluginAction, usePluginToast } from "@paperclipai/plugin-sdk/ui";
import { errorText } from "./format.js";
import { button, input } from "./forms.js";

type Access = "none" | "read" | "read-write";
interface AppUse { slug: string; name: string; access: string }
interface StatusData {
  connections: Array<{ name: string; baseUrl: string; auth: string; methods: "read" | "read-write"; available: boolean; problem: string | null; apps: AppUse[] }>;
  problems: Array<{ index: number; name: string | null; problem: string }>;
  missing: Array<{ name: string; apps: AppUse[] }>;
}
interface GrantsData { grants: Array<{ agentId: string; connection: string; access: Access }>; agents: Array<{ id: string; name: string }> }

/** Host and base path of a connection's URL, without the scheme. */
function hostAndPath(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//, "");
}

const appList = (apps: AppUse[]) => apps.map((app) => `${app.name} (${app.access})`).join(", ");

/**
 * Spec §5: what the company's connections are and who may use them. Only status and grants are shown:
 * the secret, its reference and its id never reach this page.
 */
export function ConnectionsSection() {
  const toast = usePluginToast();
  const loadStatus = usePluginAction("connections.status");
  const loadGrants = usePluginAction("connections.grants");
  const setGrant = usePluginAction("connections.set_grant");
  const [status, setStatus] = useState<StatusData | null>(null);
  const [grants, setGrants] = useState<GrantsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () => Promise.all([loadStatus({}), loadGrants({})]).then(([s, g]) => {
    setError(null);
    setStatus(s && typeof s === "object" ? (s as StatusData) : null);
    setGrants(g && typeof g === "object" ? (g as GrantsData) : null);
  }).catch((err: unknown) => setError(errorText(err)));
  useEffect(() => { void reload(); }, []);

  const change = (agentId: string, connection: string, access: Access, title: string) => setGrant({ agentId, connection, access })
    .then(() => { toast({ title, tone: "success" }); return reload(); })
    .catch((err: unknown) => toast({ title: errorText(err), tone: "error" }));

  const names = new Set((status?.connections ?? []).map((row) => row.name));
  const agentNames = new Map((grants?.agents ?? []).map((agent) => [agent.id, agent.name]));
  const orphans = (grants?.grants ?? []).filter((grant) => !names.has(grant.connection) || !agentNames.has(grant.agentId));
  const grantOf = (agentId: string, connection: string): Access => grants?.grants.find((grant) => grant.agentId === agentId && grant.connection === connection)?.access ?? "none";

  return (
    <section className="flex min-w-0 flex-col gap-3" data-kyoube-section="connections">
      <h2 className="text-sm font-semibold">Connections</h2>
      <p className="text-foreground/70">Connections let apps and agents call outside services with a company secret; they never see the key. Set them up under Settings → Plugins → Kyoube Data &amp; Apps, with this company selected.</p>
      {error && <div className="text-red-600">{error}</div>}
      {status && (
        <>
          <div className="w-full max-w-3xl overflow-x-auto" data-kyoube-scroll="">
            <table className="w-full text-sm">
              <thead><tr className="bg-accent/40 text-left"><th className="px-2 py-1">Connection</th><th className="px-2 py-1">Service</th><th className="px-2 py-1">Auth</th><th className="px-2 py-1">Methods</th><th className="px-2 py-1">Status</th><th className="px-2 py-1">Used by</th></tr></thead>
              <tbody>
                {status.connections.map((row) => (
                  <tr key={row.name} className="border-t">
                    <td className="px-2 py-1 font-medium">{row.name}</td>
                    <td className="break-all px-2 py-1" data-kyoube-break="">{hostAndPath(row.baseUrl)}</td>
                    <td className="px-2 py-1">{row.auth}</td>
                    <td className="px-2 py-1">{row.methods}</td>
                    <td className="px-2 py-1">{row.available ? "ready" : (row.problem ?? "secret doesn't resolve")}</td>
                    <td className="px-2 py-1 text-foreground/70">{row.apps.length > 0 ? appList(row.apps) : "no apps"}</td>
                  </tr>
                ))}
                {status.connections.length === 0 && <tr><td className="px-2 py-2 text-foreground/60" colSpan={6}>No connections are set up.</td></tr>}
              </tbody>
            </table>
          </div>
          {status.problems.length > 0 && (
            <ul className="list-disc pl-5 text-red-600">
              {status.problems.map((problem) => <li key={problem.index}>Entry {problem.index + 1}{problem.name ? ` (${problem.name})` : ""}: {problem.problem}</li>)}
            </ul>
          )}
          {status.missing.length > 0 && (
            <ul className="list-disc pl-5">
              {status.missing.map((row) => <li key={row.name}><code>{row.name}</code> is missing: {appList(row.apps)} declare it, but it isn't set up.</li>)}
            </ul>
          )}
        </>
      )}
      {status && grants && status.connections.length > 0 && (
        <div className="w-full max-w-3xl overflow-x-auto" data-kyoube-scroll="" data-kyoube-grid="connection-grants">
          <table className="w-full text-sm">
            <thead><tr className="bg-accent/40 text-left"><th className="px-2 py-1">Agent</th>{status.connections.map((row) => <th key={row.name} className="px-2 py-1">{row.name}</th>)}</tr></thead>
            <tbody>
              {grants.agents.map((agent) => (
                <tr key={agent.id} className="border-t">
                  <td className="px-2 py-1">{agent.name}</td>
                  {status.connections.map((row) => {
                    const current = grantOf(agent.id, row.name);
                    const shown = current === "read-write" && row.methods === "read" ? "read" : current;
                    return (
                      <td key={row.name} className="px-2 py-1">
                        <select className={input} aria-label={`${agent.name} on ${row.name}`} value={shown} onChange={(event) => { void change(agent.id, row.name, event.target.value as Access, `${agent.name} → ${row.name}: ${event.target.value}`); }}>
                          <option value="none">none</option>
                          <option value="read">read</option>
                          {row.methods === "read-write" && <option value="read-write">read-write</option>}
                        </select>
                      </td>
                    );
                  })}
                </tr>
              ))}
              {grants.agents.length === 0 && <tr><td className="px-2 py-2 text-foreground/60" colSpan={status.connections.length + 1}>No agents in this company yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {orphans.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="font-medium">Grants that no longer match a connection or an agent</div>
          {orphans.map((grant) => (
            <div key={`${grant.agentId}:${grant.connection}`} className="flex flex-wrap items-center gap-2">
              <span className="break-all" data-kyoube-break="">{agentNames.get(grant.agentId) ?? grant.agentId} · {grant.connection} · {grant.access}</span>
              <button type="button" className={button} onClick={() => { void change(grant.agentId, grant.connection, "none", "Grant removed"); }}>Remove</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
