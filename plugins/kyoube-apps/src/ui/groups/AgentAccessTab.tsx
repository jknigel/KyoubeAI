import { useEffect, useState } from "react";
import type { PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { errorText } from "../format.js";

/** The agent page's Access tab: which groups restrict this agent (docs/groups.md). */
export function AgentAccessTab({ context }: PluginDetailTabProps) {
  const load = usePluginAction("groups.agent");
  const [names, setNames] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const agentId = context.entityId ?? "";
  useEffect(() => { if (agentId) load({ agentId }).then((r) => setNames(r as string[])).catch((err) => setError(errorText(err))); }, [agentId]);
  if (error) return <div className="p-4 text-sm text-red-600">{error}</div>;
  if (!names) return null;
  return (
    <div className="p-4 text-sm">
      {names.length === 0
        ? <p>Everyone in the company can give this agent work.</p>
        : <p>Restricted to: <strong>{names.join(", ")}</strong>. Only members of these groups (and owners and admins) can give this agent work or chat with it.</p>}
    </div>
  );
}
