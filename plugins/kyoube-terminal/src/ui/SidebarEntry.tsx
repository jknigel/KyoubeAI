import type { PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { useHostContext, useHostNavigation, usePluginData } from "@paperclipai/plugin-sdk/ui";

export const PAGE_PATH = "/terminal";

export function SidebarEntry(_props: PluginSidebarProps) {
  const host = useHostContext();
  const navigation = useHostNavigation();
  const canOpen = usePluginData<{ allowed: boolean; role: string | null }>("terminal.can_open", {
    companyId: host.companyId,
    userId: host.userId,
  });
  if (canOpen.loading || !canOpen.data?.allowed) return null;
  return (
    <a
      {...navigation.linkProps(PAGE_PATH)}
      className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-foreground/80 transition-colors hover:bg-accent/50 hover:text-foreground"
    >
      <span aria-hidden="true">›_</span>
      <span>Terminal</span>
    </a>
  );
}
