import React, {useEffect, useState} from 'react';

// Review links (scripts/reviews.mjs through /api/reviews, the same routes as the MCP
// share_version / list_versions / revoke_review_link): every final export that
// passed QC is a version; a link opens a mobile page with the latest one.
type Version = {v: number; createdAt: string; durationSec: number; sizeBytes: number; proxyBytes: number; playable: boolean};
type Link = {id: string; createdAt: string; expiresAt: string; revokedAt: string | null; state: 'live' | 'expired' | 'revoked'};

const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;
const when = (iso: string) => new Date(iso).toLocaleString(undefined, {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'});

export const SharePanel: React.FC<{projectId: string | null; refreshKey?: unknown; notify: (msg: string, kind: 'error' | 'ok') => void}> = ({projectId, refreshKey, notify}) => {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{versions: Version[]; links: Link[]} | null>(null);
  const [fresh, setFresh] = useState<{id: string; url: string} | null>(null); // the token is shown once, right after creating it
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!projectId) return;
    try { setData(await fetch(`/api/reviews/${projectId}`).then((r) => r.json())); } catch { setData(null); }
  };
  useEffect(() => { setFresh(null); load(); }, [projectId, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const copy = async (url: string) => {
    try { await navigator.clipboard.writeText(url); notify('Review link copied', 'ok'); } catch { notify('Copy failed — select the link and copy it', 'error'); }
  };
  const create = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/reviews/${projectId}/links`, {method: 'POST', body: '{}'});
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
      setFresh({id: j.id, url: j.url});
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
        title="A private link (30 days) that plays the final exports of this project on a phone"
        className="flex items-center gap-1 text-body-sm text-primary hover:underline"
      >
        <span className="material-symbols-outlined text-[16px]">link</span>Share link
      </button>
      {open && (
        <div className="absolute right-0 top-8 w-80 bg-surface-container-high border border-outline-variant rounded-lg shadow-xl p-3 space-y-3 text-body-sm z-50">
          <div>
            <div className="text-[11px] uppercase text-on-surface-variant mb-1">Versions (finals that passed QC)</div>
            <ul className="max-h-32 overflow-auto space-y-0.5">
              {versions.map((v) => (
                <li key={v.v} className={`flex justify-between ${v.playable ? '' : 'opacity-40'}`} title={v.playable ? '' : 'proxy removed — not on the page'}>
                  <span className="font-mono">v{v.v}</span>
                  <span className="text-on-surface-variant">{when(v.createdAt)} · {v.durationSec.toFixed(1)}s · {mb(v.sizeBytes)}</span>
                </li>
              ))}
            </ul>
          </div>
          {fresh && (
            <div className="space-y-1">
              <input readOnly value={fresh.url} onFocus={(e) => e.currentTarget.select()} className="w-full bg-surface-container-lowest border border-outline-variant/40 rounded px-2 py-1 font-mono text-[11px]" />
              <p className="text-[11px] text-on-surface-variant">Copied. This address is shown only once — keep it.</p>
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
