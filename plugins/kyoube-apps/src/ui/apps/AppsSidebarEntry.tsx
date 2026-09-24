import { useMemo } from "react";
import type { PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { useHostContext, usePluginData } from "@paperclipai/plugin-sdk/ui";
import { KyoubeNavLink } from "../nav-link.js";
import { appsPagePath } from "../../apps/page-route.js";

export function AppsSidebarEntry(_props: PluginSidebarProps) {
  const host = useHostContext();
  // Ruling P2-R26 (carried into P3-R9): memoise the params object on its
  // scalar inputs — usePluginData re-fetches whenever the object's identity
  // changes, and a fresh literal every render would poll forever.
  const params = useMemo(() => ({ companyId: host.companyId, userId: host.userId }), [host.companyId, host.userId]);
  const access = usePluginData<{ level: string }>("data.access", params);
  if (access.loading || !access.data || access.data.level === "none") return null;
  return <KyoubeNavLink to={appsPagePath()} icon="apps" label="Apps" navId="apps" />;
}
