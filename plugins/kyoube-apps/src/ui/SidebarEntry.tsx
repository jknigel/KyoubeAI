import { useMemo } from "react";
import type { PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { useHostContext, useHostNavigation, usePluginData } from "@paperclipai/plugin-sdk/ui";

export function SidebarEntry(_props: PluginSidebarProps) {
  const host = useHostContext();
  const navigation = useHostNavigation();
  // Ruling P2-R26: memoise the params object on its scalar inputs so its
  // identity is stable across renders (usePluginData re-fetches on identity
  // change, and a fresh object literal every render would poll forever).
  const params = useMemo(() => ({ companyId: host.companyId, userId: host.userId }), [host.companyId, host.userId]);
  const access = usePluginData<{ level: string }>("data.access", params);
  if (access.loading || !access.data || access.data.level === "none") return null;
  return (
    <a {...navigation.linkProps("/data")} className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-foreground/80 transition-colors hover:bg-accent/50 hover:text-foreground">
      <span aria-hidden="true">▦</span>
      <span>Data</span>
    </a>
  );
}
