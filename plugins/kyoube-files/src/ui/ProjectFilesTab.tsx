import type { PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";
import { ProjectFiles } from "./ProjectFiles.js";

/** The **Files** tab on a project page: the project's folder, full width. */
export function ProjectFilesTab({ context }: PluginDetailTabProps) {
  return <ProjectFiles projectId={context.entityId} layout="wide" />;
}
