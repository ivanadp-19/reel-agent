import React, {useEffect, useState} from 'react';

// The render jobs of this project (scripts/render-jobs.mjs through /api/render-jobs —
// the same routes as the MCP start_render / render_status / list_render_jobs /
// cancel_render and scripts/render-cli.mjs). Jobs live on disk: an export started here,
// by the agent or from the CLI shows up, keeps going when the tab is closed, and
// survives a backend restart.
export type RenderJob = {
  id: string; status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; draft: boolean; projectId: string | null;
  stage?: string; label?: string; progress?: number; frames?: {done: number; total: number}; etaSec?: number | null; ahead?: number;
  createdAt: string; startedAt?: string; finishedAt?: string; error?: string;
  result?: {file?: string; renderSec?: number; qc?: string; version?: number; versionError?: string; master?: {hit: boolean}};
};

export const fmtSec = (s?: number | null) => (s == null || !Number.isFinite(s) ? '' : s >= 60 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s` : `${Math.round(s)}s`);
const when = (iso: string) => new Date(iso).toLocaleString(undefined, {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'});
const COLOR: Record<RenderJob['status'], string> = {queued: 'text-on-surface-variant', running: 'text-primary', done: 'text-[#39d98a]', failed: 'text-error', cancelled: 'text-on-surface-variant'};

export const cancelRender = async (id: string) => {
  const r = await fetch(`/api/render-jobs/${id}/cancel`, {method: 'POST', body: '{}'});
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'failed');
};

export const RenderJobs: React.FC<{projectId: string | null; refreshKey?: unknown; notify: (msg: string, kind: 'error' | 'ok') => void}> = ({projectId, refreshKey, notify}) => {
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<RenderJob[]>([]);

  const load = async () => {
    if (!projectId) return setJobs([]);
    try { setJobs((await fetch(`/api/render-jobs?project=${encodeURIComponent(projectId)}&limit=15`).then((r) => r.json())).jobs ?? []); } catch { /* backend restarting — keep the last list */ }
  };
  useEffect(() => { load(); }, [projectId, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // while the panel is open, or anything is still in flight, refresh every few seconds
  const active = jobs.some((j) => j.status === 'queued' || j.status === 'running');
  useEffect(() => {
    if (!open && !active) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [open, active, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = async (id: string) => {
    try { await cancelRender(id); notify('Render cancelled', 'ok'); } catch (e) { notify('Could not cancel: ' + (e as Error).message, 'error'); }
    load();
  };

  if (!projectId || !jobs.length) return null;
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} title="The renders of this project — they keep going when you close the tab" className="flex items-center gap-1 text-body-sm text-primary hover:underline">
        <span className={`material-symbols-outlined text-[16px] ${active ? 'animate-spin' : ''}`}>{active ? 'progress_activity' : 'movie'}</span>Renders{active ? ` (${jobs.filter((j) => j.status === 'queued' || j.status === 'running').length})` : ''}
      </button>
      {open && (
        <div className="absolute right-0 top-8 w-96 bg-surface-container-high border border-outline-variant rounded-lg shadow-xl p-3 text-body-sm z-50">
          <div className="text-[11px] uppercase text-on-surface-variant mb-2">Renders of this project (newest first)</div>
          <ul className="max-h-80 overflow-auto space-y-2">
            {jobs.map((j) => (
              <li key={j.id} className="space-y-1">
                <div className="flex justify-between items-center gap-2">
                  <span className="truncate">
                    <span className="font-bold">{j.draft ? 'Draft' : 'Final'}</span>{' '}
                    <span className="text-on-surface-variant">{when(j.createdAt)}</span>
                  </span>
                  <span className={`shrink-0 ${COLOR[j.status]}`}>
                    {j.status === 'queued' ? `Queued${j.ahead ? ` — ${j.ahead} ahead` : ''}` : j.status === 'running' ? `${j.progress ?? 0}%` : j.status}
                  </span>
                </div>
                {j.status === 'running' && (
                  <>
                    <div className="h-1 bg-surface-variant rounded"><div className="h-1 bg-primary rounded transition-all" style={{width: `${j.progress ?? 0}%`}} /></div>
                    <div className="text-[11px] text-on-surface-variant">{j.label}{j.etaSec ? ` · ~${fmtSec(j.etaSec)} left` : ''}</div>
                  </>
                )}
                {j.status === 'failed' && <div className="text-[11px] text-error break-words">{j.error}</div>}
                <div className="flex gap-3 text-[11px]">
                  {j.status === 'done' && j.result?.file && <a href={j.result.file} download className="text-[#39d98a] hover:underline">↓ Download</a>}
                  {j.status === 'done' && j.result?.renderSec != null && <span className="text-on-surface-variant">{fmtSec(j.result.renderSec)}{j.result.master?.hit ? ' · cached master' : ''}</span>}
                  {j.status === 'done' && j.result?.version && <span className="text-on-surface-variant">review v{j.result.version}</span>}
                  {j.status === 'done' && j.result?.qc && <span title={j.result.qc} className="text-on-surface-variant cursor-help">QC ✓</span>}
                  {(j.status === 'queued' || j.status === 'running') && <button onClick={() => cancel(j.id)} className="text-error hover:underline">Cancel</button>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
