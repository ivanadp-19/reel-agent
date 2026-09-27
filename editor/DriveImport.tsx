import React, {useEffect, useState} from 'react';
import {createPortal} from 'react-dom';
import {useEditor} from './store';
import {pollJob} from './jobs';
import {Btn} from './ui';
import {identityStem, parseStem} from '../src/validate';

type Take = {script: number | null; variant: Record<string, number> | null; stem: string | null};
type DriveFile = {id: string; name: string; size: number; modifiedTime: string | null; proposed: Take; fits?: string | null};
type Row = DriveFile & {on: boolean; stem: string};
type Done = {added: {name: string; clip: string}[]; skipped: {name: string; why: string}[]};

const FOLDER_KEY = 'reel.driveFolder'; // this viewer's last folder, a convenience only
const lastFolder = () => { try { return localStorage.getItem(FOLDER_KEY) ?? ''; } catch { return ''; } };
const input = 'bg-surface-container-lowest text-on-surface border border-outline-variant/40 focus:border-primary focus:outline-none rounded px-2 py-1 text-[12px]';

// "Importar de Drive" (server/drive.mjs, the MCP's list_drive / import_drive, `reel drive`): the backend lists a
// folder its service account can read and proposes each file's take from its name; the user confirms or corrects
// it here (R2-27), then the import runs as a job. The clips arrive through the editor's live reload of the project.
export const DriveImport: React.FC<{onClose: () => void}> = ({onClose}) => {
  const {projectId, identity} = useEditor();
  const [folder, setFolder] = useState(lastFolder);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const list = async () => {
    setError(null); setDone(null); setBusy('Listing the folder…');
    try { localStorage.setItem(FOLDER_KEY, folder.trim()); } catch {}
    try {
      const r = await fetch(`/api/drive/list?${new URLSearchParams({folder: folder.trim(), ...(projectId ? {project: projectId} : {})})}`);
      const b = await r.json();
      if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`);
      // a file is ticked when its name proposes a take that fits this project; the rest wait for the user
      setRows((b.files as DriveFile[]).map((f) => ({...f, stem: f.proposed.stem ?? (identity ? `G${identity.script}` : ''), on: !!f.proposed.stem && !f.fits})));
    } catch (e) {
      setRows(null);
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(null);
  };
  const setRow = (id: string, patch: Partial<Row>) => setRows((rs) => rs && rs.map((r) => (r.id === id ? {...r, ...patch} : r)));
  const picked = rows?.filter((r) => r.on) ?? [];
  const unreadable = picked.filter((r) => !parseStem(r.stem));

  const start = async () => {
    setError(null); setBusy('Starting the import…');
    try {
      const files = picked.map((r) => ({fileId: r.id, ...parseStem(r.stem)}));
      const r = await fetch('/api/drive/import', {method: 'POST', body: JSON.stringify({project_id: projectId, files})});
      const b = await r.json();
      if (!b.jobId) throw new Error(b.error ?? `HTTP ${r.status}`);
      await new Promise<void>((resolve, reject) => pollJob('/api/drive/import', b.jobId, (s) => setBusy(`${s.progress ?? 0}% · ${s.label ?? ''}`), resolve, (m) => reject(new Error(m)), 9600));
      setDone(await fetch(`/api/drive/import/${b.jobId}`).then((x) => x.json()));
      setRows(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(null);
  };

  // on document.body: the Assets column's stacking context would put the timeline over it
  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={() => !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="drive-title" onClick={(e) => e.stopPropagation()}
        className="bg-surface-container w-full max-w-[640px] max-h-[85vh] flex flex-col rounded-xl border border-outline-variant shadow-xl">
        <div className="p-4 border-b border-outline-variant flex items-center justify-between">
          <h2 id="drive-title" className="text-label-bold font-label-bold uppercase tracking-wider text-on-surface-variant">Importar de Drive</h2>
          <button onClick={onClose} disabled={!!busy} title="Close" className="material-symbols-outlined text-[18px] text-on-surface-variant hover:text-on-surface disabled:opacity-30">close</button>
        </div>
        <div className="p-4 space-y-3 overflow-y-auto">
          <label className="text-[11px] text-on-surface-variant block" htmlFor="drive-folder">Folder shared with the backend's service account — its id or its link</label>
          <div className="flex gap-2">
            <input id="drive-folder" autoFocus value={folder} onChange={(e) => setFolder(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && folder.trim() && !busy) list(); }}
              placeholder="https://drive.google.com/drive/folders/…" className={`flex-1 min-w-0 ${input}`} />
            <Btn onClick={list} disabled={!folder.trim() || !!busy}>List</Btn>
          </div>
          {busy && <p className="text-[11px] text-primary flex items-center gap-2"><span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span><span className="truncate">{busy}</span></p>}
          {error && <p role="alert" className="text-[11px] text-error break-words">{error}</p>}
          {done && (
            <p className="text-[11px] text-on-surface break-words">
              {done.added.length} added{done.added.length ? `: ${done.added.map((a) => a.name).join(', ')}` : ''}
              {done.skipped.length ? ` · ${done.skipped.length} already there (${done.skipped.map((s) => `${s.name}: ${s.why}`).join('; ')})` : ''} — they appear on the timeline in a moment.
            </p>
          )}
          {rows && (
            <>
              <p className="text-[11px] text-on-surface-variant/70">
                The take of each file comes from its name: check it before importing. G2 = the body every variant shares; G2_H1 = hook 1, G2_C1 = CTA 1, G3_V2 = version 2.
                {identity ? ` This project is ${identityStem(identity)}: only its script and variant are imported.` : ''}
              </p>
              {!rows.length && <p className="text-body-sm text-on-surface-variant/60">No videos in that folder.</p>}
              <ul className="divide-y divide-outline-variant/30">
                {rows.map((r) => {
                  const ok = !!parseStem(r.stem);
                  return (
                    <li key={r.id} className="py-2 flex items-center gap-2">
                      <input type="checkbox" checked={r.on} onChange={(e) => setRow(r.id, {on: e.target.checked})} aria-label={`Import ${r.name}`} className="accent-primary" />
                      <div className="flex-1 min-w-0">
                        <p className="text-body-sm truncate" title={r.name}>{r.name}</p>
                        <p className="text-[10px] text-on-surface-variant font-mono">
                          {(r.size / 2 ** 20).toFixed(1)} MB{r.stem === r.proposed.stem && r.fits ? ` · not this project's: ${r.fits}` : ''}
                        </p>
                      </div>
                      <input value={r.stem} onChange={(e) => setRow(r.id, {stem: e.target.value.toUpperCase()})} aria-label={`Take of ${r.name}`} aria-invalid={!ok}
                        placeholder="G2_H1" className={`w-24 font-mono ${input} ${ok ? '' : 'border-error'}`} />
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
        {rows && rows.length > 0 && (
          <div className="p-4 border-t border-outline-variant flex items-center justify-between gap-3">
            <span className="text-[11px] text-on-surface-variant">{unreadable.length ? `${unreadable.length} take(s) to fix (G2, G2_H1, G2_C1, G3_V2)` : `${picked.length} of ${rows.length} selected`}</span>
            <Btn primary onClick={start} disabled={!picked.length || !!unreadable.length || !!busy || !projectId}>Import {picked.length || ''}</Btn>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};
