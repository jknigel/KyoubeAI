export interface GroupLite { id: string; agents: string[]; apps: string[] }

/** What a change opens to everyone: agents and apps left in no group (docs/groups.md, "open by default"). */
export function openedBy(groups: GroupLite[], change: { deleteId?: string; groupId?: string; nextAgents?: string[]; nextApps?: string[] }): { agents: string[]; apps: string[] } {
  const target = groups.find((group) => group.id === (change.deleteId ?? change.groupId));
  if (!target) return { agents: [], apps: [] };
  const others = groups.filter((group) => group.id !== target.id);
  const elsewhere = (key: "agents" | "apps", id: string) => others.some((group) => group[key].includes(id));
  const kept = (key: "agents" | "apps") => (change.deleteId ? [] : (key === "agents" ? change.nextAgents : change.nextApps) ?? target[key]);
  const lost = (key: "agents" | "apps") => target[key].filter((id) => !kept(key).includes(id) && !elsewhere(key, id));
  return { agents: lost("agents"), apps: lost("apps") };
}
