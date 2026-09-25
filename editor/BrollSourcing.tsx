import React, {useState} from 'react';
import {useEditor} from './store';
import {placeClips} from '../src/timeline';
import {projectBrolls, type BrollItem} from '../src/brollModel';
import {suggestBroll, type Suggestion} from '../src/brollMatch';
import type {TClip} from '../src/cuts';
import {runJob, readPublic} from './jobs';
import {Btn, Label, Section, Select, TextInput} from './ui';

// B-roll sourcing in the editor: stock search (search_stock → add_broll) and
// the own-library suggestions (suggest_broll), computed with the same shared
// matcher the MCP tool uses; black footage gets a COVER suggestion.

type StockRow = {src: string; duration?: number; size?: string; alt?: string; page?: string; thumb?: string};
export type LibAsset = {id: string; src: string; kind: 'video' | 'image'; label: string; durationSec?: number | null; tags?: string[]; desc?: string; sheet?: string | null};
const MODES: BrollItem['mode'][] = ['fullscreen', 'top', 'inset', 'card', 'carousel'];

export const StockSearch: React.FC<{notify: (msg: string, kind: 'error' | 'ok') => void; initialQuery?: string}> = ({notify, initialQuery}) => {
  const {clips, currentFrame, addBroll} = useEditor();
  const [q, setQ] = useState(initialQuery ?? '');
  const [kind, setKind] = useState<'video' | 'image'>('video');
  const [mode, setMode] = useState<BrollItem['mode']>('inset');
  const [rows, setRows] = useState<StockRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const search = async (query = q) => {
    if (!query.trim()) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/stock?q=${encodeURIComponent(query)}&kind=${kind}&count=6`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'search failed');
      setRows(d);
      if (!d.length) notify('Nothing on Pexels for that', 'ok');
    } catch (e) { notify('Stock search: ' + (e as Error).message, 'error'); }
    setBusy(false);
  };
  return (
    <Section title="Stock (Pexels)" hint="Portrait video or photos; the credit is in the file's page. Your own footage first.">
      <div className="flex gap-1">
        <TextInput value={q} onChange={setQ} placeholder="what to show, e.g. wine cellar" />
        <Select value={kind} onChange={(v) => setKind(v as 'video' | 'image')} options={[{value: 'video'}, {value: 'image'}]} className="!w-24" />
        <Btn onClick={() => search()} disabled={busy || !q.trim()}>{busy ? '…' : 'Search'}</Btn>
      </div>
      {rows && rows.length > 0 && (
        <>
          <div className="flex items-center gap-2"><Label>Add as</Label><Select value={mode} onChange={(m) => setMode(m as BrollItem['mode'])} options={MODES.map((m) => ({value: m}))} className="!w-28" /></div>
          <div className="grid grid-cols-3 gap-1.5">
            {rows.map((r, i) => (
              <button
                key={i}
                onClick={() => { addBroll(currentFrame, {src: r.src, kind, mode, durationSec: Math.min(8, Math.max(0.5, r.duration ?? 4)), source: 'pexels', query: q}); notify('Stock B-roll added at the playhead', 'ok'); }}
                disabled={!clips.length}
                title={`${r.alt ?? ''}${r.duration ? ` ${r.duration}s ${r.size}` : ''}\n${r.page ?? ''}\nclick to add at the playhead`}
                className="relative rounded overflow-hidden border border-outline-variant/40 hover:border-primary aspect-[9/16] bg-surface-container-lowest"
              >
                {r.thumb ? <img src={r.thumb} alt={r.alt ?? ''} className="w-full h-full object-cover" /> : <span className="material-symbols-outlined text-on-surface-variant">{kind === 'video' ? 'movie' : 'image'}</span>}
                {r.duration != null && <span className="absolute bottom-0.5 right-0.5 bg-surface-container/80 text-[9px] px-1 rounded font-mono">{r.duration}s</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </Section>
  );
};

export const BrollSuggestions: React.FC<{library: LibAsset[]; mode: BrollItem['mode']; notify: (msg: string, kind: 'error' | 'ok') => void; onStockQuery: (q: string) => void}> = ({library, mode, notify, onStockQuery}) => {
  const {meta, clips, brolls, lang, offMic, addBroll} = useEditor();
  const [out, setOut] = useState<Suggestion[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!meta) return null;
  const fps = meta.fps;
  const tagged = library.filter((a) => a.tags?.length);

  const suggest = async () => {
    setBusy('Transcribing…');
    try {
      await runJob('/api/transcribe', {clips, lang, offMic}, (s) => setBusy(`${s.label ?? ''} ${s.progress ?? 0}%`));
      const tr = await readPublic<TClip[]>('transcript.json');
      const placed = placeClips(clips, fps);
      const mentions: {wid: string; word: string; startMs: number; endMs: number}[] = [];
      for (const pc of placed) {
        const t = tr.find((x) => x.clipId === pc.clip.id);
        if (!t) continue;
        const inMs = pc.clip.inSec * 1000, speed = pc.clip.speed ?? 1;
        for (const w of t.words) if (!w.off) mentions.push({wid: `${t.source}:${w.i}`, word: w.word, startMs: pc.startMs + (Math.max(w.startMs, inMs) - inMs) / speed, endMs: pc.startMs + (Math.min(w.endMs, pc.clip.outSec * 1000) - inMs) / speed});
      }
      mentions.sort((a, b) => a.startMs - b.startMs);
      setBusy('Looking for black footage…');
      const black: {startMs: number; endMs: number}[] = [];
      for (const pc of placed) {
        const spans: {startMs: number; endMs: number}[] = await fetch(`/api/black?src=${encodeURIComponent(pc.clip.src)}`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
        const inMs = pc.clip.inSec * 1000, outMs = pc.clip.outSec * 1000, speed = pc.clip.speed ?? 1;
        for (const s of spans) { const a = Math.max(s.startMs, inMs), b = Math.min(s.endMs, outMs); if (b > a) black.push({startMs: pc.startMs + (a - inMs) / speed, endMs: pc.startMs + (b - inMs) / speed}); }
      }
      const existing = projectBrolls(brolls, clips, fps).map((b) => ({startMs: b.startMs, endMs: b.endMs}));
      const lastK = mentions.findLastIndex((_, i) => i > 0 && /[.!?]$/.test(mentions[i - 1].word));
      const totalMs = placed[placed.length - 1]?.endMs ?? 0;
      const s = suggestBroll(mentions, tagged.map((a) => ({id: a.id, kind: a.kind, durationSec: a.durationSec ?? undefined, tags: a.tags ?? [], desc: a.desc, label: a.label})), {totalMs, black, existing, lastSentenceStartMs: lastK > 0 ? mentions[lastK].startMs : undefined});
      setOut(s);
      if (!s.length) notify(tagged.length ? 'No mention matches the library tags' + (black.length ? '' : ', and there is no black footage to cover') : 'The library has no tagged assets — tag them in the Assets panel', 'ok');
    } catch (e) { notify('Suggest failed: ' + (e as Error).message, 'error'); }
    setBusy(null);
  };
  const apply = (s: Suggestion) => {
    const a = library.find((x) => x.id === s.assetId);
    if (!a) { if (s.query) onStockQuery(s.query); return; }
    addBroll(Math.round((s.startMs / 1000) * fps), {src: a.src, kind: a.kind, mode: s.cover ? 'fullscreen' : mode, durationSec: (s.endMs - s.startMs) / 1000, source: 'own', query: a.label, assetId: a.id});
    setOut((o) => o?.filter((x) => x !== s) ?? null);
    notify(`B-roll added: ${a.label}`, 'ok');
  };

  return (
    <Section title="Suggestions" hint="Your tagged footage over the mention its tags match (0.5–8 s, one per ~9 s, never over the hook or the close), and every black stretch that must be covered.">
      <Btn onClick={suggest} disabled={!!busy || !clips.length} className="w-full"><span className={`material-symbols-outlined text-[16px] ${busy ? 'animate-spin' : ''}`}>{busy ? 'progress_activity' : 'auto_fix_high'}</span>{busy ?? 'Suggest B-roll'}</Btn>
      {out && out.length > 0 && (
        <div className="space-y-1.5">
          {out.map((s, i) => {
            const a = library.find((x) => x.id === s.assetId);
            return (
              <div key={i} className={`p-2 rounded border text-[11px] ${s.cover ? 'border-error/50 bg-error-container/10' : 'border-outline-variant/30 bg-surface-variant/20'}`}>
                <div className="flex justify-between items-center">
                  <span className="font-mono text-on-surface-variant">{(s.startMs / 1000).toFixed(1)}–{(s.endMs / 1000).toFixed(1)}s{s.cover ? ' · COVER' : ''}</span>
                  <Btn onClick={() => apply(s)} title={a ? 'add this cue' : 'search stock for it'}>{a ? 'Add' : 'Stock…'}</Btn>
                </div>
                <p className="text-on-surface truncate">{a ? `${a.kind === 'video' ? '🎬' : '🖼'} ${a.label}` : `search_stock "${s.query}"`}</p>
                <p className="text-on-surface-variant/70">{s.why}</p>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
};
