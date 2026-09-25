import React, {useEffect, useRef, useState} from 'react';
import {useEditor} from './store';
import {clipDurationSec} from '../src/timeline';
import {fmtMB, isVideoFile, pct, uploadFile, type UploadItem} from './upload';

export type ProjectMeta = {id: string; name: string; clips: number; updatedAt: string | null; thumb: string | null};
type HealthCheck = {id: string; ok: boolean; label: string; hint: string; optional?: boolean};
type Health = {ok: boolean; checks: HealthCheck[]};

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const ago = (iso: string | null) => {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
};

// Home screen: open a recent project, or drop clips to start a new one.
export const Start: React.FC<{
  projects: ProjectMeta[];
  onNew: () => void;
  onOpen: (id: string) => void;
  onRefresh: () => void;
}> = ({projects, onNew, onOpen, onRefresh}) => {
  const {clips, addClip} = useEditor();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const checkHealth = () => fetch('/api/health').then((r) => r.json()).then(setHealth).catch(() => setHealth(null));
  useEffect(() => { checkHealth(); }, []);
  const problems = health?.checks.filter((c) => !c.ok) ?? [];

  // one upload at a time (the backend transcodes each one), every file with its own row:
  // queued → uploading (%, MB) → processing on the server → done | error (the server's message)
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const busy = uploads.some((u) => u.phase === 'queued' || u.phase === 'uploading' || u.phase === 'processing');
  const patch = (key: string, p: Partial<UploadItem>) => setUploads((l) => l.map((u) => (u.key === key ? {...u, ...p} : u)));

  const upload = async (file: File, key: string) => {
    patch(key, {phase: 'uploading'});
    try {
      const clip = await uploadFile<{id?: string; error?: string}>('/api/add-clip?name=' + encodeURIComponent(file.name), file, {
        progress: (loaded) => patch(key, {loaded}),
        uploaded: () => patch(key, {phase: 'processing', loaded: file.size}),
      });
      if (!clip?.id) throw new Error(clip?.error || 'the server did not return a clip');
      addClip(clip as Parameters<typeof addClip>[0]);
      patch(key, {phase: 'done'});
    } catch (e) {
      patch(key, {phase: 'error', error: e instanceof Error ? e.message : String(e)});
    }
  };
  // files picked or dropped while others are still going wait behind them
  const queue = useRef(Promise.resolve());
  const importFiles = (files: File[]) => {
    const vids = files.filter(isVideoFile);
    setSkipped(files.filter((f) => !isVideoFile(f)).map((f) => f.name));
    if (!vids.length) return;
    const items: UploadItem[] = vids.map((f, i) => ({key: `${Date.now()}-${i}-${f.name}`, name: f.name, size: f.size, loaded: 0, phase: 'queued'}));
    // rows that finished fine go; running, queued and failed ones stay
    setUploads((l) => [...l.filter((u) => u.phase !== 'done'), ...items]);
    for (let i = 0; i < vids.length; i++) queue.current = queue.current.then(() => upload(vids[i], items[i].key));
  };
  const failed = uploads.filter((u) => u.phase === 'error');
  // closing the tab mid-upload loses the file: ask first
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);
  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    importFiles(files);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    importFiles(Array.from(e.dataTransfer.files ?? []));
  };
  const del = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await fetch('/api/projects/' + id, {method: 'DELETE'}).catch(() => {});
    onRefresh();
  };
  // duplicate_project: a copy under a new id, a sandbox for experiments
  const dup = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      const p = await fetch('/api/projects/' + id).then((r) => r.json());
      const {createdAt: _c, updatedAt: _u, ...rest} = p;
      await fetch(`/api/projects/p-${Date.now()}`, {method: 'POST', body: JSON.stringify({...rest, name: `${p.name || 'Untitled project'} (copy)`})});
    } catch { /* ignore */ }
    onRefresh();
  };

  return (
    <div className="h-screen bg-background text-on-surface flex flex-col items-center overflow-y-auto py-12 px-8">
      <div className="w-full max-w-3xl">
        <div className="mb-8 text-center">
          <h1 className="text-headline-lg font-headline-lg font-bold">reel-agent</h1>
          <p className="text-body-md text-on-surface-variant mt-1">Open a recent project, or start a new one: upload clips, then create the project</p>
        </div>

        {/* Setup problems (from /api/health): shown until everything the AI steps need is in place */}
        {problems.length > 0 && (
          <div className="mb-6 rounded-xl border border-outline-variant/60 bg-surface-container-low p-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-body-md font-bold">Setup — {problems.filter((c) => !c.optional).length ? 'a few things are missing' : 'optional'}</p>
              <button onClick={checkHealth} className="text-[11px] uppercase tracking-wide text-primary hover:underline">Re-check</button>
            </div>
            <ul className="space-y-1.5">
              {problems.map((c) => (
                <li key={c.id} className="flex gap-2 text-body-sm">
                  <span className={`material-symbols-outlined text-[18px] ${c.optional ? 'text-on-surface-variant' : 'text-error'}`}>{c.optional ? 'info' : 'error'}</span>
                  <span><span className="font-medium">{c.label}</span> <span className="text-on-surface-variant">— {c.hint}</span></span>
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-on-surface-variant mt-3">Quick fix: <code className="px-1 rounded bg-surface-container">npm run setup</code> in the project folder, then fill <code className="px-1 rounded bg-surface-container">.env</code>.</p>
          </div>
        )}

        {/* New project. The file input is visually hidden but stays in the page and the
            accessibility tree (not display:none), so browser automation can find and fill it;
            the "Choose files" button is its <label>. */}
        <input
          id="start-file-input"
          ref={inputRef}
          type="file"
          accept="video/*"
          multiple
          onChange={onPick}
          aria-label="Choose video files"
          data-testid="clip-file-input"
          className="sr-only"
        />
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          data-testid="clip-dropzone"
          className={`w-full rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-3 py-10 px-6 transition-all ${
            dragOver ? 'border-primary bg-primary-container/10' : 'border-outline-variant bg-surface-container-low'
          }`}
        >
          <span className={`material-symbols-outlined text-[48px] text-primary ${busy ? 'animate-spin' : ''}`}>{busy ? 'progress_activity' : 'video_library'}</span>
          <p className="text-body-md text-on-surface font-bold">
            {clips.length ? 'Step 2 — create the project' : 'Step 1 — add your clips'}
          </p>
          <p className="text-body-sm text-on-surface-variant text-center max-w-md">
            {busy
              ? 'Uploading… each clip is also converted on the server before it is ready. Keep this tab open.'
              : clips.length
                ? `${clips.length} clip${clips.length > 1 ? 's' : ''} uploaded, but no project exists yet. Click “Create project” to save them as a new project and open the editor — or add more clips first.`
                : 'Upload the videos for a new reel. Then you create the project from them in step 2.'}
          </p>
          <div className="flex gap-2 flex-wrap justify-center">
            <label
              htmlFor="start-file-input"
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
              className={clips.length
                ? 'cursor-pointer px-4 py-2 rounded-lg border border-outline-variant text-on-surface-variant hover:bg-surface-variant text-body-md font-bold'
                : 'cursor-pointer bg-primary-container text-on-primary-container px-6 py-2.5 rounded-lg font-bold text-body-md hover:brightness-110 active:scale-95 transition-all'}
            >
              {clips.length ? 'Add more clips' : 'Choose files'}
            </label>
            {clips.length > 0 && (
              <button
                onClick={onNew}
                disabled={busy}
                title={busy ? 'Wait for the uploads to finish' : 'Save the uploaded clips as a new project and open the editor'}
                className="bg-primary-container text-on-primary-container px-5 py-2 rounded-lg font-bold text-body-md hover:brightness-110 active:scale-95 transition-all flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Create project <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
              </button>
            )}
          </div>
          <p className="text-[11px] text-on-surface-variant">or drag &amp; drop videos here (mp4, mov, m4v, webm, mkv)</p>

          {uploads.length > 0 && (
            <ul className="w-full max-w-lg mt-2 space-y-2" aria-live="polite" data-testid="upload-list">
              {uploads.map((u) => (
                <li key={u.key} data-phase={u.phase} className="rounded-lg bg-surface-container px-3 py-2 text-body-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-medium" title={u.name}>{u.name}</span>
                    <span className={`shrink-0 text-[11px] ${u.phase === 'error' ? 'text-error' : u.phase === 'done' ? 'text-primary' : 'text-on-surface-variant'}`}>
                      {u.phase === 'queued' && `Waiting · ${fmtMB(u.size)}`}
                      {u.phase === 'uploading' && `${pct(u.loaded, u.size)}% · ${fmtMB(u.loaded)} / ${fmtMB(u.size)}`}
                      {u.phase === 'processing' && 'Uploaded — processing on the server…'}
                      {u.phase === 'done' && 'Ready'}
                      {u.phase === 'error' && 'Failed'}
                    </span>
                  </div>
                  {(u.phase === 'uploading' || u.phase === 'processing') && (
                    <div
                      className="mt-1.5 h-1.5 rounded bg-surface-variant overflow-hidden"
                      role="progressbar"
                      aria-label={`Upload of ${u.name}`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={u.phase === 'processing' ? 100 : pct(u.loaded, u.size)}
                    >
                      <div
                        className={`h-full bg-primary transition-[width] ${u.phase === 'processing' ? 'animate-pulse' : ''}`}
                        style={{width: `${u.phase === 'processing' ? 100 : pct(u.loaded, u.size)}%`}}
                      />
                    </div>
                  )}
                  {u.phase === 'processing' && (
                    <p className="mt-1 text-[11px] text-on-surface-variant">Converting the video and making a thumbnail. Large or 4K/HDR clips can take a few minutes.</p>
                  )}
                  {u.phase === 'error' && <p role="alert" className="mt-1 text-[11px] text-error break-words">{u.error}</p>}
                </li>
              ))}
            </ul>
          )}
          {failed.length > 0 && !busy && (
            <button onClick={() => setUploads((l) => l.filter((u) => u.phase !== 'error'))} className="text-[11px] uppercase tracking-wide text-primary hover:underline">
              Dismiss errors
            </button>
          )}
          {skipped.length > 0 && (
            <p role="alert" className="text-[11px] text-error text-center">
              Skipped (not a video): {skipped.join(', ')}
            </p>
          )}
        </div>

        {/* Recent projects */}
        {projects.length > 0 && (
          <div className="mt-10">
            <h2 className="text-label-bold font-label-bold uppercase tracking-wider text-on-surface-variant mb-3">Recent projects</h2>
            <div className="grid grid-cols-3 gap-3">
              {projects.map((p) => (
                <div
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpen(p.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(p.id); } }}
                  className="group relative text-left rounded-lg overflow-hidden border border-outline-variant/50 bg-surface-container-low hover:border-primary transition-all cursor-pointer"
                >
                  <div className="aspect-video bg-surface-container relative">
                    {p.thumb ? (
                      <img src={p.thumb} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-on-surface-variant/40">
                        <span className="material-symbols-outlined">movie</span>
                      </div>
                    )}
                    <button
                      onClick={(e) => del(e, p.id)}
                      title="Delete project"
                      className="absolute top-1 right-1 w-6 h-6 rounded bg-surface-container-lowest/80 text-on-surface-variant hover:text-error opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                    >
                      <span className="material-symbols-outlined text-[16px]">delete</span>
                    </button>
                    <button
                      onClick={(e) => dup(e, p.id)}
                      title="Duplicate project"
                      className="absolute top-1 right-8 w-6 h-6 rounded bg-surface-container-lowest/80 text-on-surface-variant hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                    >
                      <span className="material-symbols-outlined text-[16px]">content_copy</span>
                    </button>
                  </div>
                  <div className="p-2">
                    <p className="text-body-sm font-medium truncate">{p.name}</p>
                    <p className="text-[11px] text-on-surface-variant">{p.clips} clip{p.clips === 1 ? '' : 's'} · {ago(p.updatedAt)}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
