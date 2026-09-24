import type { PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { useHostContext, useHostLocation, useHostNavigation, usePluginData } from "@paperclipai/plugin-sdk/ui";

export const PAGE_PATH = "/terminal";

// The core's own sidebar-row classes (its SidebarNavItem), so the link sits in
// the sidebar exactly like the core's rows. `data-kyoube-nav` marks it for
// docker/theme/theme.css, which moves Terminal to the Studio Workspace page.
const NAV_BASE = "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 pointer-coarse:py-1 text-(length:--text-compact) font-medium transition-colors";
const NAV_IDLE = "text-foreground/80 hover:bg-accent/50 hover:text-foreground";
const NAV_ACTIVE = "bg-accent text-foreground";

export function SidebarEntry(_props: PluginSidebarProps) {
  const host = useHostContext();
  const navigation = useHostNavigation();
  const location = useHostLocation();
  const canOpen = usePluginData<{ allowed: boolean; role: string | null }>("terminal.can_open", {
    companyId: host.companyId,
    userId: host.userId,
  });
  if (canOpen.loading || !canOpen.data?.allowed) return null;
  const props = navigation.linkProps(PAGE_PATH);
  const here = location.pathname.replace(/\/+$/, "");
  const active = !!props.href && (here === props.href || here.startsWith(`${props.href}/`));
  return (
    <a {...props} data-kyoube-nav="terminal" aria-current={active ? "page" : undefined} className={`${NAV_BASE} ${active ? NAV_ACTIVE : NAV_IDLE}`}>
      <span className="relative shrink-0">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-4 w-4">
          <path d="m4 17 6-6-6-6" />
          <path d="M12 19h8" />
        </svg>
      </span>
      <span className="kyoube-nav-text min-w-0 flex-1 truncate">Terminal</span>
    </a>
  );
}
