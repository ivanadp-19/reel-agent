import React, {useEffect, useRef, useState} from 'react';
import type {PlayerRef} from '@remotion/player';
import {useEditor} from './store';
import {placeClips} from '../src/timeline';
import {findCutCandidates, planWordCuts, type Candidate, type CutRange, type TClip} from '../src/cuts';
import {runJob, readPublic} from './jobs';
import {Btn} from './ui';

// Left column, "Transcript": the words of every clip in timeline order with
// their ids (get_transcript), off-mic runs and pauses marked; click a word to
// seek, shift-click to close a range, Cut to remove it (cut_words); Suggest
// runs find_cut_candidates and lets you approve the list in one go.

const PAUSE_MS = 400;
const KIND_LABEL: Record<Candidate['kind'], string> = {retake: 'retake', filler: 'filler', meta: 'meta', 'off-mic': 'off-mic'};
const widOf = (source: string, i: number) => `${source}:${i}`;
const idxOf = (wid: string) => Number(wid.slice(wid.lastIndexOf(':') + 1));

export const TranscriptPanel: React.FC<{playerRef: React.RefObject<PlayerRef | null>; notify: (msg: string, kind: 'error' | 'ok') => void}> = ({playerRef, notify}) => {
  const {meta, clips, lang, offMic, currentFrame, cutWords, selectClip} = useEditor();
  const [tr, setTr] = useState<TClip[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sel, setSel] = useState<{clipId: string; source: string; a: number; b: number} | null>(null);
  const [cands, setCands] = useState<Candidate[] | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const runId = useRef(0);

  // (re)transcribe when the cut changes: cached per source, so a few seconds after the first run
  const key = `${clips.map((c) => `${c.id}:${c.inSec}:${c.outSec}`).join('|')}#${lang}#${offMic}`;
  useEffect(() => {
    if (!clips.length) { setTr([]); return; }
    const id = ++runId.current;
    setBusy('Transcribing…');
    runJob('/api/transcribe', {clips, lang, offMic}, (s) => setBusy(`${s.label ?? 'Transcribing'} ${s.progress ?? 0}%`))
      .then(() => readPublic<TClip[]>('transcript.json'))
      .then((t) => { if (id === runId.current) { setTr(Array.isArray(t) ? t : []); setSel(null); setCands(null); } })
      .catch((e) => notify('Transcription failed: ' + (e as Error).message, 'error'))
      .finally(() => { if (id === runId.current) setBusy(null); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!meta) return null;
  const fps = meta.fps;
  const placed = placeClips(clips, fps);
  const nowMs = (currentFrame / fps) * 1000;
  // source ms on a clip → timeline ms
  const toAbs = (pc: (typeof placed)[number], srcMs: number) => pc.startMs + (Math.max(srcMs, pc.clip.inSec * 1000) - pc.clip.inSec * 1000) / (pc.clip.speed ?? 1);
  const seekAbs = (ms: number) => playerRef.current?.seekTo(Math.max(0, Math.round((ms / 1000) * fps) + 1));

  const clickWord = (e: React.MouseEvent, clipId: string, source: string, i: number, absMs: number) => {
    if (e.shiftKey && sel && sel.clipId === clipId) setSel({...sel, a: Math.min(sel.a, i), b: Math.max(sel.a, i)});
    else { setSel({clipId, source, a: i, b: i}); seekAbs(absMs); selectClip(clipId); }
  };
  const inSel = (clipId: string, i: number) => !!sel && sel.clipId === clipId && i >= sel.a && i <= sel.b;
  const selRange: CutRange | null = sel ? {from_wid: widOf(sel.source, sel.a), to_wid: widOf(sel.source, sel.b)} : null;

  const cut = (ranges: CutRange[]) => {
    if (!tr) return;
    const {spans, errors} = planWordCuts(tr, clips, ranges);
    if (errors.length) notify(errors[0], 'error');
    if (!spans.length) return;
    cutWords(tr, ranges);
    setSel(null); setCands(null);
    notify(`Cut ${spans.length} stretch${spans.length > 1 ? 'es' : ''}: ${spans.map((s) => `"${s.text.length > 30 ? s.text.slice(0, 30) + '…' : s.text}"`).join(', ')}`, 'ok');
  };
  const suggest = () => {
    if (!tr) return;
    const c = findCutCandidates(tr);
    setCands(c); setChecked(new Set(c.map((_, i) => i)));
    if (!c.length) notify('No cut candidates: no retakes, fillers, meta talk or off-mic lines', 'ok');
  };
  const candAbs = (c: Candidate) => {
    const pc = placed.find((p) => p.clip.id === c.clipId);
    const t = tr?.find((x) => x.clipId === c.clipId);
    const w = t?.words.find((x) => x.i === idxOf(c.from));
    return pc && w ? toAbs(pc, w.startMs) : null;
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="p-3 border-b border-outline-variant/40 space-y-2 shrink-0">
        <div className="flex gap-2">
          <Btn onClick={() => selRange && cut([selRange])} disabled={!sel || !!busy} primary className="flex-1" title="Remove the selected words; the cut snaps into the pauses around them">
            <span className="material-symbols-outlined text-[16px]">content_cut</span>{sel ? `Cut ${sel.b - sel.a + 1} word${sel.b > sel.a ? 's' : ''}` : 'Cut selection'}
          </Btn>
          <Btn onClick={suggest} disabled={!tr?.length || !!busy} className="flex-1" title="Retakes (the last take wins), fillers, meta talk and off-mic lines">
            <span className="material-symbols-outlined text-[16px]">auto_fix_high</span>Suggest cuts
          </Btn>
        </div>
        <p className="text-[10px] text-on-surface-variant/60">{busy ?? 'Click a word to seek, shift-click to close a range.'}</p>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4 select-none">
        {/* candidates */}
        {cands && cands.length > 0 && (
          <div className="rounded-lg border border-primary/40 bg-surface-variant/30 p-2 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-label-bold font-label-bold uppercase text-primary">{cands.length} candidates</span>
              <button onClick={() => setCands(null)} className="material-symbols-outlined text-[16px] text-on-surface-variant hover:text-on-surface">close</button>
            </div>
            {cands.map((c, i) => (
              <label key={i} className="flex gap-2 items-start text-[11px] cursor-pointer" onClick={() => { const ms = candAbs(c); if (ms != null) seekAbs(ms); }}>
                <input type="checkbox" checked={checked.has(i)} onChange={(e) => { const n = new Set(checked); e.target.checked ? n.add(i) : n.delete(i); setChecked(n); }} onClick={(e) => e.stopPropagation()} className="mt-0.5 accent-primary" />
                <span className="min-w-0">
                  <span className={`uppercase font-mono text-[9px] px-1 rounded mr-1 ${c.kind === 'retake' ? 'bg-tertiary-container/40 text-tertiary' : c.kind === 'off-mic' ? 'bg-error-container/40 text-error' : 'bg-surface-container-highest text-on-surface-variant'}`}>{KIND_LABEL[c.kind]}</span>
                  <span className="text-on-surface">“{c.text.length > 70 ? c.text.slice(0, 70) + '…' : c.text}”</span>
                  {c.note && <span className="text-on-surface-variant/70"> ({c.note})</span>}
                  {c.keep && <span className="block text-on-surface-variant/60">kept take: “{c.keep.text.slice(0, 50)}{c.keep.text.length > 50 ? '…' : ''}”</span>}
                </span>
              </label>
            ))}
            <Btn primary onClick={() => cut(cands.filter((_, i) => checked.has(i)).map((c) => (c.to === c.from ? {from_wid: c.from} : {from_wid: c.from, to_wid: c.to})))} disabled={!checked.size || !!busy} className="w-full">
              Cut selected ({checked.size})
            </Btn>
          </div>
        )}

        {/* words per clip */}
        {!clips.length && <p className="text-body-sm text-on-surface-variant/50">No clips loaded.</p>}
        {tr && placed.map((pc) => {
          const t = tr.find((x) => x.clipId === pc.clip.id);
          const inMs = pc.clip.inSec * 1000, outMs = pc.clip.outSec * 1000;
          const multi = new Set(t?.words.map((w) => w.speaker).filter(Boolean)).size > 1;
          let spk: string | undefined;
          return (
            <div key={pc.clip.id}>
              <div className="flex justify-between items-baseline mb-1">
                <span className="text-[10px] font-label-bold uppercase tracking-wider text-on-surface-variant truncate">{pc.clip.label ?? pc.clip.id}</span>
                <span className="text-[9px] font-mono text-on-surface-variant/60">{(pc.startMs / 1000).toFixed(1)}–{(pc.endMs / 1000).toFixed(1)}s</span>
              </div>
              {!t ? (
                <p className="text-[11px] text-on-surface-variant/50 italic">{busy ? 'updating…' : 'no transcript for this piece'}</p>
              ) : !t.words.length ? (
                <p className="text-[11px] text-on-surface-variant/50 italic">(no speech)</p>
              ) : (
                <p className="leading-6 text-[12px]">
                  {t.words.map((w, k) => {
                    const prev = t.words[k - 1];
                    const abs = toAbs(pc, w.startMs);
                    const absEnd = toAbs(pc, Math.min(w.endMs, outMs));
                    const cur = nowMs >= abs && nowMs < absEnd;
                    const gap = prev ? w.startMs - prev.endMs : 0;
                    const spkTag = multi && w.speaker && w.speaker !== spk ? (spk = w.speaker) : null;
                    const offStart = w.off && !prev?.off;
                    return (
                      <React.Fragment key={w.i}>
                        {gap > PAUSE_MS && <span className="text-[9px] font-mono text-on-surface-variant/40 mx-0.5">·{(gap / 1000).toFixed(1)}s</span>}
                        {spkTag && <span className="text-[9px] font-mono px-1 rounded bg-secondary-container/30 text-secondary mr-1">{spkTag}</span>}
                        {offStart && <span className="material-symbols-outlined text-[12px] text-error/80 align-middle mr-0.5" title="off-mic: a quieter second voice away from the mic">mic_off</span>}
                        <button
                          onClick={(e) => clickWord(e, pc.clip.id, t.source, w.i, abs)}
                          title={`${t.source}:${w.i} · ${(w.startMs / 1000).toFixed(2)}s${w.off ? ' · off-mic' : ''}`}
                          className={`px-0.5 rounded-sm ${inSel(pc.clip.id, w.i) ? 'bg-primary-container text-on-primary-container' : cur ? 'bg-surface-variant text-primary' : w.off ? 'text-on-surface-variant/50 italic' : 'text-on-surface hover:bg-surface-variant/60'} ${w.startMs < inMs - 1 || w.endMs > outMs + 1 ? 'opacity-40' : ''}`}
                        >
                          {w.word}
                        </button>{' '}
                      </React.Fragment>
                    );
                  })}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
