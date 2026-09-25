import React, {useEffect, useState} from 'react';
import {Btn, Label, Select, TextInput} from './ui';

// Decorative assets for the sticker template: the local library first
// (list_assets), then a search with clean licenses (search_asset), and as a
// last resort a generated PNG (generate_asset, costs money — confirmed).

type AssetRow = {id: string; src: string; kind?: string; format?: string; license?: string; source?: string; credit?: string; prompt?: string; title?: string; fromLibrary?: boolean};
const KINDS = ['sticker', 'icon', 'emoji', 'illustration'];
const GEN_KINDS = ['sticker', 'doodle', 'texture', 'ui'];

export const AssetPicker: React.FC<{value: string; onPick: (src: string) => void; notify: (msg: string, kind: 'error' | 'ok') => void}> = ({value, onPick, notify}) => {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('sticker');
  const [rows, setRows] = useState<AssetRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [genKind, setGenKind] = useState('sticker');
  const load = async (query: string) => {
    setBusy('…');
    try {
      const r = await fetch(query.trim() ? `/api/assets/search?q=${encodeURIComponent(query)}&kind=${kind}&limit=9` : `/api/assets?kind=${kind === 'illustration' ? '' : kind}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'search failed');
      setRows(Array.isArray(d) ? d : []);
      if (query.trim() && !d.length) notify('No assets found — try other words or generate one', 'ok');
    } catch (e) { notify('Assets: ' + (e as Error).message, 'error'); }
    setBusy(null);
  };
  useEffect(() => { load(''); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [kind]);
  const generate = async () => {
    if (!q.trim()) { notify('Describe the object in the search box first', 'error'); return; }
    if (!window.confirm(`Generate "${q}" as a ${genKind} with the OpenAI Images API? It costs money; the library and the free sources are checked first.`)) return;
    setBusy('Generating…');
    try {
      const r = await fetch('/api/assets/generate', {method: 'POST', body: JSON.stringify({prompt: q, kind: genKind})});
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'generation failed');
      if (d.found) { setRows(d.found); notify(`Not generated — ${d.found.length} existing asset(s) match; pick one or generate anyway from a more specific prompt`, 'ok'); }
      else { onPick(d.generated.src); setRows([{id: d.generated.src, src: d.generated.src, license: 'generated'}]); notify(d.generated.cached ? 'Reused an earlier generation' : 'Generated', 'ok'); }
    } catch (e) { notify('Generate: ' + (e as Error).message, 'error'); }
    setBusy(null);
  };
  return (
    <div className="space-y-2 p-2 rounded bg-surface-container-lowest/60 border border-outline-variant/20">
      <Label>Asset (library → search → generate)</Label>
      <div className="flex gap-1">
        <TextInput value={q} onChange={setQ} placeholder="e.g. wine glass" />
        <Select value={kind} onChange={setKind} options={KINDS.map((k) => ({value: k}))} className="!w-28" />
        <Btn onClick={() => load(q)} disabled={!!busy}>{busy ?? 'Search'}</Btn>
      </div>
      {rows.length > 0 && (
        <div className="grid grid-cols-4 gap-1">
          {rows.map((r) => (
            <button key={r.id} onClick={() => onPick(r.src)} title={`${r.title ?? r.prompt ?? r.id}\n${r.license ?? ''}${r.source ? ' · ' + r.source : ''}${r.credit ? '\ncredit: ' + r.credit : ''}`} className={`aspect-square rounded border bg-[repeating-conic-gradient(#2a2a2c_0_25%,#201f21_0_50%)] bg-[length:12px_12px] overflow-hidden ${value === r.src ? 'border-primary' : 'border-outline-variant/40 hover:border-primary/60'}`}>
              <img src={/^https?:/.test(r.src) ? r.src : '/' + r.src} alt="" className="w-full h-full object-contain" />
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-1 items-center">
        <Select value={genKind} onChange={setGenKind} options={GEN_KINDS.map((k) => ({value: k}))} className="!w-28" />
        <Btn onClick={generate} disabled={!!busy || !q.trim()} title="Last resort: OpenAI Images, transparent PNG (paid)" className="flex-1">Generate…</Btn>
      </div>
      {value && <p className="text-[10px] font-mono text-on-surface-variant/70 truncate" title={value}>{value}</p>}
    </div>
  );
};
