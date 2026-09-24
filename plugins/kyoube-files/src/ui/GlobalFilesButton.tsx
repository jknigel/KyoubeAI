import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { PluginHostContext } from "@paperclipai/plugin-sdk/ui";
import { useHostContext, useHostLocation, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { ProjectFiles } from "./ProjectFiles.js";

/** `BAP-12` from `/BAP/issues/BAP-12` (or `/issues/<uuid>`); `null` anywhere else. */
export function issueRefFromPath(pathname: string): string | null {
  const match = /^\/(?:[^/]+\/)?issues\/([^/?#]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

const OPEN_KEY = "kyoube.files.panel-open";

function readOpen(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // A private window; the panel just does not remember.
  }
}

interface Located {
  projectId: string | null;
  projectName: string | null;
  canRead: boolean;
}

/**
 * The folder icon at the right end of the breadcrumb bar. The bar's slot
 * context carries only the company, so the button reads the route: on a
 * task page it asks the worker which project the task is in and, if the
 * viewer may browse it, shows the icon. Clicking docks `TaskFilesPanel` on
 * the right of the screen; the bar (and so this component) stays mounted
 * across navigation, so the panel follows the viewer from task to task and
 * re-targets itself to each task's project.
 */
export function GlobalFilesButton({ context }: { context?: PluginHostContext }) {
  const host = useHostContext();
  const location = useHostLocation();
  const locate = usePluginAction("files.locate");
  const companyId = context?.companyId ?? host.companyId ?? null;
  const issueRef = useMemo(() => issueRefFromPath(location.pathname), [location.pathname]);
  const [located, setLocated] = useState<Located | null>(null);
  const [open, setOpen] = useState<boolean>(() => readOpen());

  useEffect(() => {
    if (!issueRef || !companyId) { setLocated(null); return; }
    let cancelled = false;
    locate({ issueRef })
      .then((result) => { if (!cancelled) setLocated(result as Located); })
      .catch(() => { if (!cancelled) setLocated(null); });
    return () => { cancelled = true; };
  }, [issueRef, companyId, locate]);

  const projectId = located?.canRead ? located.projectId : null;
  if (!issueRef || !projectId) return null;
  const toggle = () => setOpen((value) => { writeOpen(!value); return !value; });

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        aria-pressed={open}
        aria-label={open ? "Hide project files" : "Show project files"}
        title={`${open ? "Hide" : "Show"} the files of ${located?.projectName ?? "this project"}`}
        className={`inline-flex h-8 w-8 items-center justify-center rounded-md text-foreground/70 transition-colors hover:bg-accent hover:text-foreground ${open ? "bg-accent text-foreground" : ""}`}
      >
        <FolderIcon />
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <TaskFilesPanel projectId={projectId} projectName={located?.projectName ?? null} onClose={toggle} />,
        document.body,
      )}
    </>
  );
}

/**
 * The docked panel: fixed to the right edge below the breadcrumb bar (which is
 * 3rem tall), above the page but below the host's own overlays (which start at
 * z-index 1000), with no backdrop — the chat behind it stays usable.
 */
export function TaskFilesPanel(props: { projectId: string; projectName: string | null; onClose: () => void }) {
  return (
    <aside
      aria-label="Project files"
      className="fixed bottom-0 right-0 top-12 z-40 flex w-[min(34rem,100vw)] flex-col border-l border-border bg-background shadow-2xl"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <FolderIcon />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">Files</div>
          {props.projectName && <div className="truncate text-xs text-foreground/60">{props.projectName}</div>}
        </div>
        <button type="button" className="rounded px-2 py-1 text-sm hover:bg-accent" onClick={props.onClose} aria-label="Close project files">×</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <ProjectFiles key={props.projectId} projectId={props.projectId} layout="stacked" />
      </div>
    </aside>
  );
}

function FolderIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
    </svg>
  );
}
