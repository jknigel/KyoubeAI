import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownBlock, usePluginAction, usePluginToast } from "@paperclipai/plugin-sdk/ui";
import { errorCodeFrom, errorText } from "./error-code.js";
import { breadcrumbs, bytesToBase64, formatBytes, formatWhen, imageTypeOf, isMarkdown, joinPath, parentOf } from "./format.js";
import { buildPreviewSrcdoc, imageMimeOf, inlineHtmlAssets, isHtml, isSvg } from "./html-preview.js";

export const button = "rounded border px-2 py-1 text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50";
export const input = "rounded border px-2 py-1 text-sm bg-background";

/** How often the open folder is re-listed so an agent's changes show up without a click. */
export const POLL_MS = 5_000;

/**
 * The open file fills the screen below the host page's header and tab bar
 * (about 14rem on the project page), whether it is the editor, the Markdown
 * preview, an image or a rendered page: a preview that ends where its
 * content ends is unusable for anything longer than a paragraph.
 */
export const VIEWER_HEIGHT = "calc(100vh - 14rem)";

export interface Entry {
  name: string;
  path: string;
  kind: "file" | "dir" | "symlink" | "other";
  size: number;
  mtimeMs: number;
}

export interface Listing {
  path: string;
  exists: boolean;
  entries: Entry[];
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
  isPrimary: boolean;
  source: "managed" | "configured";
}

export interface Access {
  role: string | null;
  canRead: boolean;
  canWrite: boolean;
  limits: { maxEditableBytes: number; maxUploadBytes: number; maxDownloadBytes: number };
  workspaces: WorkspaceInfo[];
}

export interface ReadResult {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  encoding: "utf8" | "base64" | "none";
  content: string | null;
  binary: boolean;
  tooLarge: boolean;
}

type Notify = (title: string, tone?: "success" | "error" | "info") => void;

/** `wide` puts the listing beside the open file (the project tab); `stacked` puts it above (the task panel). */
export type FilesLayout = "wide" | "stacked";

/**
 * The whole Files surface for one project: access check, folder picker,
 * browser and file view. Mounted by the project tab and by the docked task panel.
 */
export function ProjectFiles({ projectId, layout }: { projectId: string; layout: FilesLayout }) {
  const toast = usePluginToast();
  const notify = useCallback<Notify>((title, tone = "success") => { toast({ title, tone }); }, [toast]);
  const getAccess = usePluginAction("files.workspaces");
  const [access, setAccess] = useState<Access | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAccess(null);
    setAccessError(null);
    getAccess({ projectId })
      .then((result) => {
        if (cancelled) return;
        const info = result as Access;
        setAccess(info);
        setWorkspaceId((current) => (current && info.workspaces.some((item) => item.id === current) ? current : info.workspaces[0]?.id ?? null));
      })
      .catch((error) => { if (!cancelled) setAccessError(errorText(error)); });
    return () => { cancelled = true; };
  }, [projectId, getAccess]);

  if (accessError) return <div className="p-4 text-sm text-red-600">Could not open project files: {accessError}</div>;
  if (!access) return <div className="p-4 text-sm text-foreground/60">Loading…</div>;
  if (!access.canRead) return <div className="p-4 text-sm">Your company role{access.role ? ` (${access.role})` : ""} cannot browse project files. Ask an admin to add it under Settings → Plugins → Kyoube Files.</div>;
  const workspace = access.workspaces.find((item) => item.id === workspaceId) ?? access.workspaces[0] ?? null;
  if (!workspace) return <div className="p-4 text-sm text-foreground/60">This project has no folder.</div>;

  return (
    <div className={`flex h-full flex-col gap-3 ${layout === "wide" ? "p-4" : ""}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-foreground/60">
        {access.workspaces.length > 1 && (
          <select className={input} value={workspace.id} onChange={(event) => setWorkspaceId(event.target.value)} aria-label="Workspace">
            {access.workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}{item.isPrimary ? " (primary)" : ""}</option>)}
          </select>
        )}
        <span title={workspace.source === "managed" ? "The folder the core created for this project; agents working on its tasks run here." : "The project's configured workspace folder."}>
          <code>{workspace.path}</code>
        </span>
        {!access.canWrite && <span className="rounded border px-1.5 py-0.5">read-only</span>}
      </div>
      <Browser key={`${projectId}:${workspace.id}`} projectId={projectId} workspace={workspace} access={access} notify={notify} layout={layout} />
    </div>
  );
}

function Browser(props: { projectId: string; workspace: WorkspaceInfo; access: Access; notify: Notify; layout: FilesLayout }) {
  const { projectId, workspace, access, notify, layout } = props;
  const scope = useMemo(() => ({ projectId, workspaceId: workspace.id }), [projectId, workspace.id]);
  const list = usePluginAction("files.list");
  const create = usePluginAction("files.create");
  const upload = usePluginAction("files.upload");
  const rename = usePluginAction("files.rename");
  const remove = usePluginAction("files.delete");
  const [dir, setDir] = useState("");
  const [listing, setListing] = useState<Listing | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState<"file" | "dir" | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const uploadInput = useRef<HTMLInputElement | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    list({ ...scope, path: dir })
      .then((result) => { if (!cancelled) { setListing(result as Listing); setListError(null); } })
      .catch((error) => {
        if (cancelled) return;
        // A folder an agent removed under us: go up rather than show a dead end.
        if (errorCodeFrom(error) === "not_found" && dir) { setDir(parentOf(dir)); return; }
        setListError(errorText(error));
      });
    return () => { cancelled = true; };
  }, [list, scope, dir, tick]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const run = useCallback(async (work: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await work();
      notify(success);
      refresh();
      return true;
    } catch (error) {
      notify(errorText(error), "error");
      return false;
    } finally {
      setBusy(false);
    }
  }, [notify, refresh]);

  const onUploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (file.size > access.limits.maxUploadBytes) { notify(`${file.name} is ${formatBytes(file.size)}; uploads are limited to ${formatBytes(access.limits.maxUploadBytes)}`, "error"); continue; }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const exists = listing?.entries.some((entry) => entry.name === file.name) ?? false;
      if (exists && typeof window !== "undefined" && !window.confirm(`${file.name} already exists. Replace it?`)) continue;
      await run(() => upload({ ...scope, dir, name: file.name, contentBase64: bytesToBase64(bytes), overwrite: exists }), `Uploaded ${file.name}`);
    }
    if (uploadInput.current) uploadInput.current.value = "";
  };

  const crumbs = breadcrumbs(dir);
  const entries = listing?.entries ?? [];

  const wide = layout === "wide";
  return (
    <div className={`flex min-h-0 flex-1 flex-col gap-3 ${wide ? "lg:flex-row" : ""}`}>
      <section className={`flex min-w-0 flex-col gap-2 ${wide ? "lg:w-96 lg:shrink-0" : ""}`}>
        <nav className="flex flex-wrap items-center gap-1 text-sm" aria-label="Folder path">
          <button type="button" className="rounded px-1 hover:bg-accent/50" onClick={() => setDir("")}>{workspace.name}</button>
          {crumbs.map((crumb) => (
            <span key={crumb.path} className="flex items-center gap-1">
              <span className="text-foreground/40">/</span>
              <button type="button" className="rounded px-1 hover:bg-accent/50" onClick={() => setDir(crumb.path)}>{crumb.name}</button>
            </span>
          ))}
        </nav>
        <div className="flex flex-wrap items-center gap-1">
          {access.canWrite && <button type="button" className={button} disabled={busy} onClick={() => { setCreating("file"); setRenaming(null); }}>+ File</button>}
          {access.canWrite && <button type="button" className={button} disabled={busy} onClick={() => { setCreating("dir"); setRenaming(null); }}>+ Folder</button>}
          {access.canWrite && <button type="button" className={button} disabled={busy} onClick={() => uploadInput.current?.click()}>Upload</button>}
          {access.canWrite && <input ref={uploadInput} type="file" multiple className="hidden" aria-label="Upload files" onChange={(event) => { void onUploadFiles(event.target.files); }} />}
          <button type="button" className={button} onClick={refresh} title="The list also refreshes itself every few seconds">Refresh</button>
        </div>
        {creating && (
          <NameForm
            label={creating === "dir" ? "New folder name" : "New file name"}
            submitLabel="Create"
            onCancel={() => setCreating(null)}
            onSubmit={async (name) => {
              const ok = await run(() => create({ ...scope, dir, name, kind: creating }), `Created ${name}`);
              if (ok) { setCreating(null); if (creating === "file") setSelected(joinPath(dir, name)); }
            }}
          />
        )}
        {listError && <div className="text-sm text-red-600">{listError}</div>}
        {listing && !listing.exists && (
          <div className="rounded border p-3 text-sm text-foreground/60">
            This project's folder does not exist yet — the core creates it the first time an agent works on one of its tasks.
            {access.canWrite ? " Creating a file or folder here creates it now." : ""}
          </div>
        )}
        <ul className="divide-y rounded border text-sm" aria-label="Files">
          {dir && (
            <li><button type="button" className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-accent/50" onClick={() => setDir(parentOf(dir))}><span aria-hidden="true" className="w-4 text-center">↰</span><span>..</span></button></li>
          )}
          {entries.map((entry) => (
            <li key={entry.path} className={`group flex items-center gap-2 px-2 py-1 ${entry.path === selected ? "bg-accent" : "hover:bg-accent/50"}`}>
              {renaming === entry.path ? (
                <NameForm
                  label="New name"
                  initial={entry.name}
                  submitLabel="Rename"
                  onCancel={() => setRenaming(null)}
                  onSubmit={async (name) => {
                    const ok = await run(() => rename({ ...scope, path: entry.path, newPath: joinPath(dir, name) }), `Renamed to ${name}`);
                    if (ok) { setRenaming(null); if (selected === entry.path) setSelected(joinPath(dir, name)); }
                  }}
                />
              ) : (
                <>
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => { if (entry.kind === "dir") { setDir(entry.path); setSelected(null); } else if (entry.kind === "file") setSelected(entry.path); }}
                    title={entry.kind === "symlink" ? "Symbolic link (not followed)" : entry.path}
                  >
                    <span aria-hidden="true" className="w-4 text-center text-foreground/60">{entry.kind === "dir" ? "▸" : entry.kind === "symlink" ? "↪" : "▫"}</span>
                    <span className={`truncate ${entry.kind === "dir" ? "font-medium" : ""}`}>{entry.name}{entry.kind === "dir" ? "/" : ""}</span>
                  </button>
                  <span className="hidden w-16 shrink-0 text-right text-xs text-foreground/50 sm:inline">{entry.kind === "file" ? formatBytes(entry.size) : ""}</span>
                  <span className="hidden w-20 shrink-0 text-right text-xs text-foreground/50 md:inline" title={new Date(entry.mtimeMs).toLocaleString()}>{formatWhen(entry.mtimeMs)}</span>
                  {access.canWrite && confirmDelete !== entry.path && (
                    <span className="flex shrink-0 gap-1 opacity-50 group-hover:opacity-100 focus-within:opacity-100">
                      <button type="button" className="rounded px-1 text-xs hover:bg-accent" title="Rename" aria-label={`Rename ${entry.name}`} onClick={() => { setRenaming(entry.path); setCreating(null); }}>✎</button>
                      <button type="button" className="rounded px-1 text-xs hover:bg-accent hover:text-red-600" title="Delete" aria-label={`Delete ${entry.name}`} onClick={() => setConfirmDelete(entry.path)}>×</button>
                    </span>
                  )}
                  {confirmDelete === entry.path && (
                    <span className="flex shrink-0 items-center gap-1 text-xs">
                      {entry.kind === "dir" ? "Delete folder and contents?" : "Delete?"}
                      <button type="button" className={button} disabled={busy} onClick={async () => { const ok = await run(() => remove({ ...scope, path: entry.path, recursive: entry.kind === "dir" }), `Deleted ${entry.name}`); if (ok) { setConfirmDelete(null); if (selected === entry.path) setSelected(null); } }}>Yes</button>
                      <button type="button" className={button} onClick={() => setConfirmDelete(null)}>No</button>
                    </span>
                  )}
                </>
              )}
            </li>
          ))}
          {listing && listing.exists && entries.length === 0 && <li className="px-2 py-3 text-foreground/60">Empty folder.</li>}
          {!listing && !listError && <li className="px-2 py-3 text-foreground/60">Loading…</li>}
        </ul>
      </section>
      <section className="min-w-0 flex-1">
        {selected ? (
          <FileView key={selected} scope={scope} path={selected} access={access} notify={notify} onClose={() => setSelected(null)} onChanged={refresh} />
        ) : (
          <div className="rounded border p-4 text-sm text-foreground/60">Select a file to view or edit it.</div>
        )}
      </section>
    </div>
  );
}

function NameForm(props: { label: string; initial?: string; submitLabel: string; onSubmit: (name: string) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(props.initial ?? "");
  const [pending, setPending] = useState(false);
  return (
    <form
      className="flex flex-wrap items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = name.trim();
        if (!trimmed || pending) return;
        setPending(true);
        props.onSubmit(trimmed).finally(() => setPending(false));
      }}
    >
      <input className={input} autoFocus aria-label={props.label} placeholder={props.label} value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") props.onCancel(); }} />
      <button type="submit" className={button} disabled={pending || !name.trim()}>{props.submitLabel}</button>
      <button type="button" className={button} onClick={props.onCancel}>Cancel</button>
    </form>
  );
}

/**
 * One open file: a text editor with save-conflict detection, an inline image,
 * or a download-only card for anything else.
 *
 * The conflict rule is what makes shared editing with agents safe: a save
 * carries the mtime the file had when it was loaded, and the worker refuses it
 * (`conflict`) if the file changed since — the person then reloads (losing
 * their edit) or overwrites (losing the agent's). A file that changes while it
 * is open and *not* being edited is reloaded quietly on the next poll.
 */
function FileView(props: { scope: { projectId: string; workspaceId: string }; path: string; access: Access; notify: Notify; onClose: () => void; onChanged: () => void }) {
  const { scope, path, access, notify } = props;
  const read = usePluginAction("files.read");
  const stat = usePluginAction("files.stat");
  const write = usePluginAction("files.write");
  const [file, setFile] = useState<ReadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [changedOnDisk, setChangedOnDisk] = useState(false);
  const name = name0(path);
  const html = isHtml(name);
  const svg = isSvg(name);
  // Pages and drawings open as what they are; text opens as text.
  const [preview, setPreview] = useState(html || svg);
  const [image, setImage] = useState<string | null>(null);
  const imageType = imageTypeOf(name);
  const dirty = file !== null && file.encoding === "utf8" && draft !== file.content;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const fileRef = useRef(file);
  fileRef.current = file;

  const load = useCallback(async () => {
    const result = (await read({ ...scope, path })) as ReadResult;
    setFile(result);
    setDraft(result.content ?? "");
    setConflict(false);
    setChangedOnDisk(false);
    setError(null);
    if (imageType && result.encoding !== "utf8" && result.size <= access.limits.maxDownloadBytes) {
      const raw = (await read({ ...scope, path, encoding: "base64" })) as ReadResult;
      if (raw.content) setImage(`data:${imageType};base64,${raw.content}`);
    }
  }, [read, scope, path, imageType, access.limits.maxDownloadBytes]);

  useEffect(() => {
    let cancelled = false;
    load().catch((err) => { if (!cancelled) setError(errorText(err)); });
    return () => { cancelled = true; };
  }, [load]);

  // Watch the open file: reload it when an agent changes it and nothing is
  // being typed; otherwise just say so, and let the save's conflict check
  // decide.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible" || !fileRef.current) return;
      stat({ ...scope, path })
        .then((result) => {
          const current = result as { mtimeMs: number };
          if (current.mtimeMs === fileRef.current?.mtimeMs) return;
          if (dirtyRef.current) setChangedOnDisk(true);
          else load().catch(() => undefined);
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [stat, scope, path, load]);

  const save = async (force: boolean) => {
    if (!file) return;
    setSaving(true);
    try {
      const result = (await write({ ...scope, path, content: draft, baseMtimeMs: force ? null : file.mtimeMs, mustExist: true })) as { mtimeMs: number; size: number };
      setFile({ ...file, content: draft, mtimeMs: result.mtimeMs, size: result.size });
      setConflict(false);
      setChangedOnDisk(false);
      notify(`Saved ${name}`);
      props.onChanged();
    } catch (err) {
      if (errorCodeFrom(err) === "conflict") setConflict(true);
      else notify(errorText(err), "error");
    } finally {
      setSaving(false);
    }
  };

  const download = async () => {
    try {
      const raw = (await read({ ...scope, path, encoding: "base64" })) as ReadResult;
      if (raw.tooLarge || !raw.content) { notify(`${name} is ${formatBytes(raw.size)}; downloads are limited to ${formatBytes(access.limits.maxDownloadBytes)}`, "error"); return; }
      const bytes = Uint8Array.from(atob(raw.content), (char) => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes]));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      notify(errorText(err), "error");
    }
  };

  if (error) return <div className="rounded border p-4 text-sm text-red-600">{error} <button type="button" className={button} onClick={props.onClose}>Close</button></div>;
  if (!file) return <div className="rounded border p-4 text-sm text-foreground/60">Loading {name}…</div>;

  const editable = file.encoding === "utf8" && access.canWrite;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 truncate font-mono text-sm font-semibold" title={path}>{path}</h3>
        <span className="text-xs text-foreground/50">{formatBytes(file.size)} · {formatWhen(file.mtimeMs)}</span>
        <span className="flex-1" />
        {file.encoding === "utf8" && (isMarkdown(name) || html || svg) && <button type="button" className={button} onClick={() => setPreview((value) => !value)}>{preview ? (access.canWrite ? "Edit source" : "View source") : "Preview"}</button>}
        {editable && <button type="button" className={button} disabled={!dirty || saving} onClick={() => void save(false)}>{saving ? "Saving…" : "Save"}</button>}
        {editable && dirty && <button type="button" className={button} disabled={saving} onClick={() => { setDraft(file.content ?? ""); setConflict(false); }}>Revert</button>}
        <button type="button" className={button} onClick={() => void download()}>Download</button>
        <button type="button" className={button} onClick={props.onClose}>Close</button>
      </div>
      {conflict && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-amber-500/60 bg-amber-500/10 p-2 text-sm">
          <span>This file changed on disk since you opened it — probably an agent wrote to it.</span>
          <button type="button" className={button} onClick={() => load().catch((err) => setError(errorText(err)))}>Reload (discard my edit)</button>
          <button type="button" className={button} onClick={() => void save(true)}>Overwrite with my version</button>
        </div>
      )}
      {!conflict && changedOnDisk && <div className="rounded border border-amber-500/60 bg-amber-500/10 p-2 text-sm">This file changed on disk while you were editing. Saving will ask before overwriting.</div>}
      {file.encoding === "utf8" && preview && html && <HtmlPreview key={path} html={draft} path={path} scope={scope} />}
      {file.encoding === "utf8" && preview && svg && <img src={`data:image/svg+xml;base64,${bytesToBase64(new TextEncoder().encode(draft))}`} alt={name} className="max-w-full rounded border bg-white" style={{ maxHeight: VIEWER_HEIGHT }} />}
      {file.encoding === "utf8" && preview && !html && !svg && <div className="overflow-auto rounded border p-4" style={{ minHeight: VIEWER_HEIGHT }}><MarkdownBlock content={draft} /></div>}
      {file.encoding === "utf8" && !preview && (
        <textarea className="w-full resize-y rounded border bg-background p-2 font-mono text-sm" style={{ minHeight: VIEWER_HEIGHT }} spellCheck={false} readOnly={!access.canWrite} value={draft} onChange={(event) => setDraft(event.target.value)} aria-label={`Contents of ${name}`} />
      )}
      {file.encoding !== "utf8" && image && <img src={image} alt={name} className="max-w-full rounded border" style={{ maxHeight: VIEWER_HEIGHT }} />}
      {file.encoding !== "utf8" && !image && (
        <div className="rounded border p-4 text-sm text-foreground/60">
          {file.tooLarge ? `This file is ${formatBytes(file.size)}, larger than the ${formatBytes(access.limits.maxEditableBytes)} the editor opens.` : "This is a binary file."} Use Download to get a copy.
        </div>
      )}
    </div>
  );
}

function name0(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * An HTML file shown as the page it is. The document is built once per
 * source text: the stylesheets, scripts and images it references by relative
 * path are read from the same folder and inlined (the sandbox has no network,
 * so nothing else could load them), then the policy is prepended and the
 * result handed to a sandboxed iframe. The iframe is keyed on the document so
 * a change remounts it rather than swapping `srcDoc` under a live page.
 */
function HtmlPreview(props: { html: string; path: string; scope: { projectId: string; workspaceId: string } }) {
  const { html, path, scope } = props;
  const read = usePluginAction("files.read");
  const [doc, setDoc] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dir = parentOf(path);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    let missing = 0;
    const loader = {
      text: async (assetPath: string) => {
        try {
          const result = (await read({ ...scope, path: assetPath })) as ReadResult;
          if (result.encoding !== "utf8" || result.content === null) { missing += 1; return null; }
          return result.content;
        } catch { missing += 1; return null; }
      },
      dataUrl: async (assetPath: string) => {
        const mime = imageMimeOf(assetPath);
        if (!mime) { missing += 1; return null; }
        try {
          const result = (await read({ ...scope, path: assetPath, encoding: "base64" })) as ReadResult;
          if (result.content === null) { missing += 1; return null; }
          return `data:${mime};base64,${result.content}`;
        } catch { missing += 1; return null; }
      },
    };
    inlineHtmlAssets(html, dir, loader)
      .then((inlined) => {
        if (cancelled) return;
        setDoc(buildPreviewSrcdoc(inlined));
        setNotice(missing > 0 ? `${missing} referenced file${missing === 1 ? " was" : "s were"} not found next to this page and will not show.` : null);
      })
      .catch(() => { if (!cancelled) { setDoc(buildPreviewSrcdoc(html)); setNotice(null); } });
    return () => { cancelled = true; };
  }, [html, dir, scope, read]);

  if (doc === null) return <div className="rounded border p-4 text-sm text-foreground/60">Rendering page…</div>;
  return (
    <div className="flex flex-col gap-1">
      <iframe
        key={doc}
        title={`Preview of ${name0(path)}`}
        sandbox="allow-scripts allow-forms allow-modals"
        referrerPolicy="no-referrer"
        srcDoc={doc}
        className="w-full rounded border bg-white"
        style={{ height: VIEWER_HEIGHT }}
      />
      <p className="text-xs text-foreground/50">
        {notice ? `${notice} ` : ""}Sandboxed preview: the page's own styles, scripts and images from this folder are shown; it cannot reach the network.
      </p>
    </div>
  );
}
