import { useEffect, useState } from "react";
import type { PluginCompanySettingsPageProps } from "@paperclipai/plugin-sdk/ui";
import { usePluginAction, usePluginToast } from "@paperclipai/plugin-sdk/ui";
import { errorText } from "../format.js";
import { button, input } from "../forms.js";
import { openedBy } from "./opened.js";

interface Group { id: string; name: string; dataLevel: string | null; members: string[]; agents: string[]; apps: string[] }
interface ListData { unlocked: boolean; groups: Group[]; sync: { syncedAt: string; error: string | null } | null }
interface Options { members: Array<{ id: string; role: string | null; name?: string }>; agents: Array<{ id: string; name: string }>; apps: Array<{ id: string; name: string; icon: string | null }> }
interface Draft { id?: string; name: string; level: string; members: string[]; agents: string[]; apps: string[] }

const EMPTY: Draft = { name: "", level: "", members: [], agents: [], apps: [] };

function minutesAgo(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

function CheckList(props: { title: string; items: Array<{ id: string; label: string }>; selected: string[]; onChange: (next: string[]) => void }) {
  const toggle = (id: string) => props.onChange(props.selected.includes(id) ? props.selected.filter((x) => x !== id) : [...props.selected, id]);
  return (
    <fieldset className="flex min-w-[12rem] flex-1 flex-col gap-1 rounded border p-2">
      <legend className="px-1 font-medium">{props.title}</legend>
      {props.items.map((item) => (
        <label key={item.id} className="flex items-center gap-2"><input type="checkbox" checked={props.selected.includes(item.id)} onChange={() => toggle(item.id)} /> {item.label}</label>
      ))}
      {props.items.length === 0 && <span className="text-foreground/60">None available.</span>}
    </fieldset>
  );
}

export function GroupsSettingsPage({ context }: PluginCompanySettingsPageProps) {
  const companyId = context.companyId ?? "";
  const toast = usePluginToast();
  const list = usePluginAction("groups.list");
  const loadOptions = usePluginAction("groups.options");
  const save = usePluginAction("groups.save");
  const remove = usePluginAction("groups.delete");
  const [data, setData] = useState<ListData | null>(null);
  const [options, setOptions] = useState<Options>({ members: [], agents: [], apps: [] });
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  const reload = () => list({}).then((result) => { setData(result as ListData); setError(null); }).catch((err) => setError(errorText(err)));
  useEffect(() => {
    if (!companyId) return;
    reload().catch(() => {});
    loadOptions({}).then((result) => setOptions(result as Options)).catch(() => {});
  }, [companyId]);

  const unlocked = data?.unlocked ?? false;
  const groups = data?.groups ?? [];
  const nameOf = (kind: "agents" | "apps", id: string) => options[kind].find((item) => item.id === id)?.name ?? id;
  /** Asks before a change leaves agents or apps in no group, which opens them to everyone. */
  const confirmOpened = (opened: { agents: string[]; apps: string[] }) => {
    const names = [...opened.agents.map((id) => nameOf("agents", id)), ...opened.apps.map((id) => nameOf("apps", id))];
    return names.length === 0 || window.confirm(`This makes ${names.join(", ")} usable by everyone. Continue?`);
  };
  const act = (promise: Promise<unknown>, title: string) => promise.then(() => { toast({ title, tone: "success" }); return reload(); }).catch((err) => toast({ title: errorText(err), tone: "error" }));

  const onSave = () => {
    if (!draft) return;
    if (draft.id && !confirmOpened(openedBy(groups, { groupId: draft.id, nextAgents: draft.agents, nextApps: draft.apps }))) return;
    const body = { id: draft.id, name: draft.name.trim(), dataLevel: draft.level || null, members: draft.members, agents: draft.agents, apps: draft.apps };
    void act(save({ group: body }), "Group saved").then(() => setDraft(null));
  };
  const onDelete = (group: Group) => {
    if (!confirmOpened(openedBy(groups, { deleteId: group.id }))) return;
    void act(remove({ id: group.id }), "Group deleted").then(() => setDraft((current) => (current?.id === group.id ? null : current)));
  };

  return (
    <div className="flex flex-col gap-4 p-4 text-sm">
      <h1 className="text-base font-semibold">Groups</h1>
      <p className="text-foreground/70">Groups decide which agents people may give work to, which apps they may open, and optionally their Data level. An agent or app in no group is open to everyone. Owners and admins are never restricted. Agent changes take effect within about a minute.</p>
      {error && <div className="text-red-600">{error}</div>}
      {data && (
        <>
          <p className="text-foreground/60">
            {data.sync ? `Agent rules last synced ${minutesAgo(data.sync.syncedAt)} min ago` : "Agent rules have not synced yet"}
            {data.sync?.error && <span className="ml-2 text-red-600">{data.sync.error}</span>}
          </p>
          {!unlocked && <div role="alert" className="rounded border border-amber-500 p-3">Managing groups needs a KyoubeAI licence (Settings → Plugins → KyoubeAI Licence). Existing groups are still enforced, and you can delete them.</div>}
          <div><button type="button" className={button} onClick={() => setDraft({ ...EMPTY })}>New group</button></div>
          <table className="w-full max-w-3xl text-sm">
            <thead><tr className="bg-accent/40 text-left"><th className="px-2 py-1">Group</th><th className="px-2 py-1">Data level</th><th className="px-2 py-1">Members</th><th className="px-2 py-1">Agents</th><th className="px-2 py-1">Apps</th><th className="px-2 py-1" /></tr></thead>
            <tbody>
              {groups.map((group) => (
                <tr key={group.id} className="border-t">
                  <td className="px-2 py-1"><button type="button" className="underline" onClick={() => setDraft({ id: group.id, name: group.name, level: group.dataLevel ?? "", members: group.members, agents: group.agents, apps: group.apps })}>{group.name}</button></td>
                  <td className="px-2 py-1">{group.dataLevel ?? "from role"}</td>
                  <td className="px-2 py-1">{group.members.length}</td>
                  <td className="px-2 py-1">{group.agents.length}</td>
                  <td className="px-2 py-1">{group.apps.length}</td>
                  <td className="px-2 py-1"><button type="button" className={button} onClick={() => onDelete(group)}>Delete</button></td>
                </tr>
              ))}
              {groups.length === 0 && <tr><td className="px-2 py-2 text-foreground/60" colSpan={6}>No groups yet.</td></tr>}
            </tbody>
          </table>
          {draft && (
            <section className="flex flex-col gap-3 rounded border p-3">
              <label className="flex items-center gap-2">Name <input className={input} maxLength={80} value={draft.name} disabled={!unlocked} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
              <label className="flex items-center gap-2">Data level
                <select className={input} value={draft.level} disabled={!unlocked} onChange={(event) => setDraft({ ...draft, level: event.target.value })}>
                  <option value="">Data level from role</option>
                  <option value="read">read</option>
                  <option value="write">write</option>
                  <option value="schema">schema</option>
                </select>
              </label>
              <div className="flex flex-wrap gap-3">
                <CheckList title="Members" items={options.members.map((member) => ({ id: member.id, label: `${member.name ?? member.id}${member.role ? ` (${member.role})` : ""}` }))} selected={draft.members} onChange={(members) => setDraft({ ...draft, members })} />
                <CheckList title="Agents" items={options.agents.map((agent) => ({ id: agent.id, label: agent.name }))} selected={draft.agents} onChange={(agents) => setDraft({ ...draft, agents })} />
                <CheckList title="Apps" items={options.apps.map((app) => ({ id: app.id, label: `${app.icon ?? ""} ${app.name}`.trim() }))} selected={draft.apps} onChange={(apps) => setDraft({ ...draft, apps })} />
              </div>
              <div className="flex gap-2">
                <button type="button" className={button} disabled={!unlocked || !draft.name.trim()} onClick={onSave}>Save</button>
                <button type="button" className={button} onClick={() => setDraft(null)}>Cancel</button>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
