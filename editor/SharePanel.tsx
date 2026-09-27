import React, {useEffect, useState} from 'react';

// Review links (scripts/reviews.mjs through /api/reviews, the same routes as the MCP
// share_version / list_versions / revoke_review_link): every final export that
// passed QC is a version; a link opens a mobile page with the latest one. A client's
// version carries its QC técnico label (the judge runs after it is recorded, CEO-6);
// Re-judge runs the judge again without a re-render (the MCP rejudge, the same route). What list_versions says about a
// client's pair shows here too: a master that is the client's own file (captions only), what it left out (no supers).
type Version = {v: number; createdAt: string; durationSec: number; sizeBytes: number; proxyBytes: number; playable: boolean; snapshot?: string; qcLabel?: string | null; judge?: {label: string; error?: string; findings?: {check: string; severity: string; at: number | null; msg: string}[]}; datosPorConfirmar?: {graphic: string; dato: string; src: string; atSec: number}[]; original?: {src: string; sha256: string}; omitted?: Record<string, string>; notes?: unknown[]};
type Link = {id: string; createdAt: string; expiresAt: string; revokedAt: string | null; state: 'live' | 'expired' | 'revoked'};

const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;
const when = (iso: string) => new Date(iso).toLocaleString(undefined, {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'});

export const SharePanel: React.FC<{projectId: string | null; refreshKey?: unknown; notify: (msg: string, kind: 'error' | 'ok') => void}> = ({projectId, refreshKey, notify}) => {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{versions: Version[]; links: Link[]} | null>(null);
  const [fresh, setFresh] = useState<{id: string; url: string; access: string | null} | null>(null); // the token is shown once, right after creating it
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!projectId) return;
    try { setData(await fetch(`/api/reviews/${projectId}`).then((r) => r.json())); } catch { setData(null); }
  };
  useEffect(() => { setFresh(null); load(); }, [projectId, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // while a judge runs and the panel is open, its label is re-read every 5 s
  const judging = open && (data?.versions ?? []).some((v) => v.judge?.label === 'en curso');
  useEffect(() => { if (!judging) return; const t = setInterval(load, 5000); return () => clearInterval(t); }, [judging, projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  const rejudge = async (v: number) => {
    const r = await fetch(`/api/reviews/${projectId}/versions/${v}/judge`, {method: 'POST', body: '{}'});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return notify('Could not re-judge: ' + (j.error || r.status), 'error');
    load();
  };

  const copy = async (url: string) => {
    try { await navigator.clipboard.writeText(url); notify('Review link copied', 'ok'); } catch { notify('Copy failed — select the link and copy it', 'error'); }
  };
  const create = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/reviews/${projectId}/links`, {method: 'POST', body: '{}'});
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
      setFresh({id: j.id, url: j.url, access: j.access ?? null});
      await copy(j.url);
      await load();
    } catch (e) {
      notify('Could not create the link: ' + (e as Error).message, 'error');
    } finally { setBusy(false); }
  };
  const revoke = async (id: string) => {
    const r = await fetch(`/api/reviews/${projectId}/links/${id}`, {method: 'DELETE'});
    if (!r.ok) return notify('Could not revoke the link', 'error');
    if (fresh?.id === id) setFresh(null);
    notify('Link revoked', 'ok');
    load();
  };

  const versions = data?.versions ?? [];
  if (!projectId || !versions.length) return null;
  const live = (data?.links ?? []).filter((l) => l.state === 'live');
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="A private link (30 days) that plays the final exports of this project on a phone; a client's project also needs a login of that client"
        className="flex items-center gap-1 text-body-sm text-primary hover:underline"
      >
        <span className="material-symbols-outlined text-[16px]">link</span>Share link
      </button>
      {open && (
        <div className="absolute right-0 top-8 w-80 bg-surface-container-high border border-outline-variant rounded-lg shadow-xl p-3 space-y-3 text-body-sm z-50">
          <div>
            <div className="text-[11px] uppercase text-on-surface-variant mb-1">Versions (finals that passed QC)</div>
            <ul className="max-h-40 overflow-auto space-y-0.5">
              {versions.map((v) => (
                <li key={v.v} className={v.playable ? '' : 'opacity-40'} title={v.playable ? '' : 'proxy removed — not on the page'}>
                  <div className="flex justify-between">
                    <span className="font-mono">v{v.v}</span>
                    <span className="text-on-surface-variant">{when(v.createdAt)} · {v.durationSec.toFixed(1)}s · {mb(v.sizeBytes)}</span>
                  </div>
                  {v.qcLabel && (
                    <div className="flex justify-between text-[11px]" title={v.judge?.error ?? (v.judge?.findings ?? []).map((f) => `[${f.severity}] ${f.check}${f.at != null ? ` @${f.at}s` : ''} — ${f.msg}`).join('\n')}>
                      <span className={v.judge?.label?.startsWith('superado') ? 'text-primary' : v.judge?.label === 'en curso' ? 'text-on-surface-variant' : 'text-error'}>{v.qcLabel}</span>
                      {v.judge?.label !== 'en curso' && v.snapshot && <button onClick={() => rejudge(v.v)} className="text-primary hover:underline">Re-judge</button>}
                    </div>
                  )}
                  {(v.original || v.omitted || !!v.notes?.length) && (
                    <div className="text-[11px] text-on-surface-variant" title={v.original ? `sha256 ${v.original.sha256}` : undefined}>
                      {[v.original && `master = the client's own ${v.original.src}, never re-encoded`, v.omitted && `no ${Object.keys(v.omitted).join(' / ')}: ${Object.values(v.omitted)[0]}`, v.notes?.length && `${v.notes.length} client note${v.notes.length === 1 ? '' : 's'} (bandeja)`].filter(Boolean).join(' · ')}
                    </div>
                  )}
                  {!!v.datosPorConfirmar?.length && (
                    <div className="text-[11px] text-error" title="Figures / names its graphics show that its own audio does not say — the client confirms them">
                      Datos por confirmar: {v.datosPorConfirmar.map((d) => `"${d.dato}" @${d.atSec}s`).join(', ')}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
          {fresh && (
            <div className="space-y-1">
              <input readOnly value={fresh.url} onFocus={(e) => e.currentTarget.select()} className="w-full bg-surface-container-lowest border border-outline-variant/40 rounded px-2 py-1 font-mono text-[11px]" />
              <p className="text-[11px] text-on-surface-variant">Copied. This address is shown only once — keep it.</p>
              {fresh.access && <p className="text-[11px] text-error">{fresh.access}</p>}
            </div>
          )}
          <button onClick={create} disabled={busy} className="w-full bg-primary-container text-on-primary-container rounded px-2 py-1.5 font-bold disabled:opacity-40">
            {busy ? 'Creating…' : 'Create link (30 days)'}
          </button>
          {live.length > 0 && (
            <div>
              <div className="text-[11px] uppercase text-on-surface-variant mb-1">Live links</div>
              <ul className="space-y-1">
                {live.map((l) => (
                  <li key={l.id} className="flex justify-between items-center">
                    <span><span className="font-mono">{l.id}</span> <span className="text-on-surface-variant">until {new Date(l.expiresAt).toLocaleDateString()}</span></span>
                    <button onClick={() => revoke(l.id)} className="text-error hover:underline">Revoke</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
