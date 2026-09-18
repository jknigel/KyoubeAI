import type { PluginProjectSidebarItemProps } from "@paperclipai/plugin-sdk/ui";
import { useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import { PLUGIN_ID, TAB_SLOT_ID } from "../manifest.js";

/** The project-page URL that opens this plugin's Files tab. */
export function filesTabPath(projectRef: string): string {
  return `/projects/${encodeURIComponent(projectRef)}?tab=${encodeURIComponent(`plugin:${PLUGIN_ID}:${TAB_SLOT_ID}`)}`;
}

/**
 * Rendered once per project under its row in the sidebar's Projects list, so
 * it must stay a plain link: no data fetch, no per-project bridge call. The
 * host passes the project's route ref alongside the documented `entityId`; the
 * id works as a route ref too, so it is the fallback.
 */
export function ProjectSidebarItem({ context }: PluginProjectSidebarItemProps) {
  const navigation = useHostNavigation();
  const projectRef = (context as { projectRef?: string | null }).projectRef ?? context.entityId;
  return (
    <a
      {...navigation.linkProps(filesTabPath(projectRef))}
      className="flex items-center gap-2 rounded-lg px-2 py-1 text-xs font-medium text-foreground/70 transition-colors hover:bg-accent/50 hover:text-foreground"
    >
      <span aria-hidden="true">▤</span>
      <span>Files</span>
    </a>
  );
}
