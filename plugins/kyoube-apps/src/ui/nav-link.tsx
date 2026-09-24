import type { ReactElement } from "react";
import { useHostLocation, useHostNavigation } from "@paperclipai/plugin-sdk/ui";

// The core's own sidebar-row classes (its SidebarNavItem), so these links sit
// in the sidebar exactly like the core's rows. `data-kyoube-nav` marks them
// for docker/theme/theme.css (collapsed-rail labels, ordering under Build).
const NAV_BASE = "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 pointer-coarse:py-1 text-(length:--text-compact) font-medium transition-colors";
const NAV_IDLE = "text-foreground/80 hover:bg-accent/50 hover:text-foreground";
const NAV_ACTIVE = "bg-accent text-foreground";

/** Line icons in the core's style (Lucide, 24×24, stroke 2). */
export const NAV_ICONS = {
  data: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" /><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" /></>,
  apps: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18" /><path d="M7 6.5h.01M10 6.5h.01" /></>,
} satisfies Record<string, ReactElement>;

export function isActivePath(pathname: string, href: string | undefined): boolean {
  if (!href) return false;
  const target = href.split(/[?#]/)[0]!.replace(/\/+$/, "");
  const here = pathname.replace(/\/+$/, "");
  return here === target || here.startsWith(`${target}/`);
}

export function KyoubeNavLink({ to, icon, label, navId }: { to: string; icon: keyof typeof NAV_ICONS; label: string; navId: string }) {
  const navigation = useHostNavigation();
  const location = useHostLocation();
  const props = navigation.linkProps(to);
  const active = isActivePath(location.pathname, props.href);
  return (
    <a {...props} data-kyoube-nav={navId} aria-current={active ? "page" : undefined} className={`${NAV_BASE} ${active ? NAV_ACTIVE : NAV_IDLE}`}>
      <span className="relative shrink-0">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-4 w-4">{NAV_ICONS[icon]}</svg>
      </span>
      <span className="kyoube-nav-text min-w-0 flex-1 truncate">{label}</span>
    </a>
  );
}
