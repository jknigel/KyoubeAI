import { useMemo } from "react";
import type { PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { useHostContext, useHostNavigation, usePluginData } from "@paperclipai/plugin-sdk/ui";
import { appsPagePath } from "../../apps/page-route.js";

export function AppsSidebarEntry(_props: PluginSidebarProps) {
  const host = useHostContext();
  const navigation = useHostNavigation();
  // Ruling P2-R26 (carried into P3-R9): memoise the params object on its
  // scalar inputs — usePluginData re-fetches whenever the object's identity
  // changes, and a fresh literal every render would poll forever.
  const params = useMemo(() => ({ companyId: host.companyId, userId: host.userId }), [host.companyId, host.userId]);
  const access = usePluginData<{ level: string }>("data.access", params);
  if (access.loading || !access.data || access.data.level === "none") return null;
  return (
    <a {...navigation.linkProps(appsPagePath())} className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-foreground/80 transition-colors hover:bg-accent/50 hover:text-foreground">
      <span aria-hidden="true">◫</span>
      <span>Apps</span>
    </a>
  );
}
