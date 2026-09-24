import { useMemo } from "react";
import type { PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { useHostContext, usePluginData } from "@paperclipai/plugin-sdk/ui";
import { KyoubeNavLink } from "./nav-link.js";

export function SidebarEntry(_props: PluginSidebarProps) {
  const host = useHostContext();
  // Ruling P2-R26: memoise the params object on its scalar inputs so its
  // identity is stable across renders (usePluginData re-fetches on identity
  // change, and a fresh object literal every render would poll forever).
  const params = useMemo(() => ({ companyId: host.companyId, userId: host.userId }), [host.companyId, host.userId]);
  const access = usePluginData<{ level: string }>("data.access", params);
  if (access.loading || !access.data || access.data.level === "none") return null;
  return <KyoubeNavLink to="/data" icon="data" label="Data" navId="data" />;
}
