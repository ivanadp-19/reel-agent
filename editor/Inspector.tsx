import React, {useEffect, useState} from 'react';
import type {PlayerRef} from '@remotion/player';
import {useEditor} from './store';
import {PIECES, clipDurationSec, inferPieces, placeClips, syncFamily, type Piece} from '../src/timeline';
import {eachTarget, familyTargets, unbackedData, validateIdentity} from '../src/validate';
import {pageBefore, projectCaptions} from '../src/captions';
import {projectBrolls, type BrollAsset, type BrollItem} from '../src/brollModel';
import type {PresetId} from '../src/captionPresets';
import {PACKS} from '../src/stylePacks';
import {faceKnobs, type FaceHold} from '../src/faces';
import {ENTERS, type Enter} from '../src/transitions';
import type {BrollIn, BrollOut} from '../src/motion';
import {GraphicsTab} from './GraphicsTab';
import {BrollSuggestions, StockSearch, type LibAsset} from './BrollSourcing';
import {StylesTab} from './StylesTab';
import {SettingsTab} from './SettingsTab';
import {Btn, IconBtn, Label, NumberInput, Row, Section, Select, TextInput, Toggle, fmtSec} from './ui';

type Tab = 'Clip' | 'Captions' | 'B-roll' | 'Graphics' | 'Styles' | 'Settings';
const TABS: Tab[] = ['Clip', 'Captions', 'B-roll', 'Graphics', 'Styles', 'Settings'];

const ENTER_HELP: Partial<Record<Enter | 'pack', string>> = {
  cut: 'plain cut', punch: '12 % closer — hides a jump cut inside a take', zoom: 'quick eased push-in with a short blur', whip: 'motion-blurred slide', whipDiag: 'diagonal smear out, landing from 1.3× (Prism)',
  card: 'the previous clip shrinks into a card and slides off', split: 'the previous clip breaks into 2×2 tiles', flash: '2 white frames + fade (Stack)', crossBlur: 'both clips blur through each other', spin: 'a twist under a white flash (Prime)',
  rgbFlash: 'blur + chromatic split + flash (Impact)', bands: 'three accent bands sweep through (Focus)', polyWipe: 'diagonal sweep with an accent edge (Lift)', clock: 'a pie covers then uncovers (Y2K)', mosaic: 'squares grow and shrink (Y2K)',
  disc: 'a disc from a corner covers, then retires (Orbit)', blinds: 'accent bars close and open (Form)', particles: 'the old shot dissolves left to right', diagWipe: 'a ~20° edge comes down (Linen)', blocks: 'the new shot rises with a stepped edge (Vista)',
  cardDrop: 'the new shot falls in as a card (Pop)', lightLeak: 'warm and pink flares over the cut (Lens)', pack: "the style pack's own family",
};
const ARRIVES: BrollIn[] = ['cut', 'fade', 'slideUp', 'popFrom', 'slideRight'];
const LEAVES: BrollOut[] = ['cut', 'fade', 'slideDown', 'shrink', 'fall'];
const MODES: BrollItem['mode'][] = ['fullscreen', 'top', 'inset', 'card', 'carousel'];

// Right "Inspector" panel: Clip / Captions / B-roll / Graphics / Styles / Settings.
export const Inspector: React.FC<{
  playerRef: React.RefObject<PlayerRef | null>;
  onGenerate: () => void;
  generating?: boolean;
  progressLabel?: string;
  onStyleChange: (style: PresetId) => void;
  notify: (msg: string, kind: 'error' | 'ok') => void;
}> = ({playerRef, onGenerate, generating, progressLabel, onStyleChange, notify}) => {
  const {
    meta, captions, clips, brolls, brollAssets, accentColor, captionStyle, selectedId, selectedClipId, currentFrame,
    select, selectClip, setText, movePageStart, shiftCaption, setTopPct, toggleAccent, setEmoji, pushHistory, setCaptionBehind, addCaption, deleteCaption,
    deleteClip, moveClip, setBrollMode, swapBroll, removeBroll, setBrollMotion, setBrollTiming, addBroll,
    setClipVolume, toggleClipMute, setClipSpeed, setClipEnter, setClipAudioCut, setClipTags, setTransitionPattern, applySpeedRamp,
    captionsOff, setCaptionsOff, guion, setGuion, projectId, identity, faceShift, faceHold, brand, setFaceKnobs,
  } = useEditor();
  const knobs = faceKnobs({faceShift, faceHold, brand});
  const [tab, setTab] = useState<Tab>('Captions');
  const [ramp, setRamp] = useState({from: 1, to: 2, steps: 3});
  const [pageText, setPageText] = useState(''); // the hand-typed page (no JS dialog: automation-driven browsers cannot answer one)
  const [library, setLibrary] = useState<LibAsset[]>([]); // the machine's own B-roll library (add_broll_assets / the Assets panel), with tags
  const [stockQuery, setStockQuery] = useState<string | undefined>(undefined);
  const [newCue, setNewCue] = useState<{asset: string; mode: BrollItem['mode']; sec: number}>({asset: '', mode: 'inset', sec: 3});
  const [syncExcept, setSyncExcept] = useState('');
  const [syncing, setSyncing] = useState(false);
  // a clip selected anywhere (timeline, assets, preview) opens its tab
  useEffect(() => { if (selectedClipId) setTab('Clip'); }, [selectedClipId]);
  useEffect(() => {
    if (tab !== 'B-roll') return;
    fetch('/api/broll-library').then((r) => (r.ok ? r.json() : [])).then((l) => setLibrary(Array.isArray(l) ? l : [])).catch(() => setLibrary([]));
  }, [tab]);
  if (!meta) return null;

  // captions + b-roll are clip-anchored → project for display (absolute times + order)
  const projCaps = projectCaptions(captions, clips, meta.fps);
  const projBrolls = projectBrolls(brolls, clips, meta.fps);
  const selClip = clips.find((c) => c.id === selectedClipId);
  const placedSel = selClip && placeClips(clips, meta.fps).find((p) => p.clip.id === selClip.id);
  // a move the data no longer allows (a page changed under the buttons) is reported, never thrown out of the click
  const movePage = (id: string, wid: string) => { try { movePageStart(id, wid); } catch (e) { notify(String((e as Error)?.message ?? e), 'error'); } };
  const seekMs = (ms: number) => playerRef.current?.seekTo(Math.round((ms / 1000) * meta.fps));
  const packKind = PACKS[captionStyle]?.transition ?? 'whip';
  const assets: BrollAsset[] = [...brollAssets, ...library.filter((a) => !brollAssets.some((b) => b.id === a.id)).map((a) => ({id: a.id, src: a.src, kind: a.kind, label: a.label}))];
  const rampPieces = ramp.steps;
  const rampOk = selClip ? (selClip.outSec - selClip.inSec) / rampPieces >= 0.3 : false;

  const family = validateIdentity(identity).identity?.family;
  // sync_family: this variant's body onto the other variants of its script — the MCP's selection (familyTargets) and
  // copy (syncFamily); each sibling read with its words (the graphics' data against its own audio, unbackedData) and its
  // lock (one another agent holds is left as it is), saved by its own CAS route (GET then POST with its updatedAt: one
  // saved meanwhile is a 409, reported, never overwritten)
  const syncBody = async () => {
    if (!projectId) return;
    setSyncing(true);
    try {
      const r = familyTargets(await fetch('/api/projects').then((x) => x.json()), projectId, undefined, syncExcept.split(',').map((x) => x.trim()).filter(Boolean));
      if (r.error) throw new Error(r.error);
      const s = useEditor.getState();
      const from = {clips: s.clips, captions: s.captions, brolls: s.brolls, graphics: s.graphics, mattes: s.mattes, grade: s.grade, hiddenWids: s.hiddenWids, identity: validateIdentity(s.identity).identity};
      const {failed, lines} = await eachTarget(r.ids, async (id) => {
        const at = `/api/projects/${encodeURIComponent(id)}`;
        const got = await Promise.all([fetch(at), fetch(`${at}/words`), fetch(`${at}/lock`)]), bad = got.find((x) => !x.ok);
        if (bad) throw new Error(`could not read it (${bad.status})`);
        const [cur, tr, lock] = await Promise.all(got.map((x) => x.json()));
        if (lock.message) throw new Error(lock.message); // another agent is editing it: left as it is, as the MCP does
        const out = syncFamily(from, cur, {words: tr, unbacked: (q) => unbackedData(q, tr)});
        if ('error' in out) throw new Error(out.error);
        const w = await fetch(at, {method: 'POST', body: JSON.stringify({...out.project, sync: {from: projectId, replaced: out.replaced}})});
        if (w.status === 409) throw new Error('it changed meanwhile — sync again');
        if (!w.ok) throw new Error((await w.json().catch(() => ({}))).error ?? `save failed (${w.status})`);
        return out.said;
      });
      notify(`Body of the family ${family}: ${r.ids.length - failed} of ${r.ids.length} synced — ${lines.join('; ')}`, failed ? 'error' : 'ok');
    } catch (e) { notify('Sync body: ' + (e as Error).message, 'error'); }
    setSyncing(false);
  };

  const addPage = () => {
    const t = pageText.trim();
    if (!t) return;
    addCaption(currentFrame, t);
    setPageText('');
  };
  const addCue = () => {
    const a = assets.find((x) => x.id === newCue.asset) ?? assets[0];
    if (!a) return;
    addBroll(currentFrame, {src: a.src, kind: a.kind, mode: newCue.mode, durationSec: Math.min(8, Math.max(0.3, newCue.sec)), source: 'own', query: a.label, assetId: a.id});
    notify(`B-roll added: ${a.label}`, 'ok');
  };

  return (
    <aside className="w-96 bg-surface-container-high border-l border-outline-variant flex flex-col h-full shrink-0">
      <div className="p-panel-padding pb-0">
        <h2 className="text-headline-md font-headline-md text-on-surface">Inspector</h2>
        <p className="text-body-sm text-on-surface-variant mb-4">Properties</p>
        <div className="flex border-b border-outline-variant">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 pb-2 text-[10px] font-label-bold uppercase tracking-wide border-b-2 transition-colors ${
                tab === t ? 'border-primary text-on-primary-container' : 'border-transparent text-on-surface-variant hover:text-on-surface'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-panel-padding">
        {tab === 'Clip' && (
          <div className="space-y-5">
            {selClip ? (
              <div className="p-3 rounded-lg bg-surface-variant/40 border border-primary/30">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-label-bold font-label-bold uppercase text-primary">Clip</span>
                  <div className="flex gap-1">
                    <IconBtn icon="chevron_left" title="Move left" onClick={() => moveClip(selClip.id, -1)} />
                    <IconBtn icon="chevron_right" title="Move right" onClick={() => moveClip(selClip.id, 1)} />
                    <IconBtn icon="delete" title="Delete take" danger onClick={() => { deleteClip(selClip.id); selectClip(null); }} />
                  </div>
                </div>
                <p className="text-body-sm text-on-surface truncate mb-2">{selClip.label ?? selClip.id}</p>
                <Row k="In" v={`${selClip.inSec.toFixed(2)}s`} />
                <Row k="Out" v={`${selClip.outSec.toFixed(2)}s`} />
                <Row k="Duration" v={`${clipDurationSec(selClip).toFixed(2)}s`} />

                {/* playback speed */}
                <Label>Speed: {(selClip.speed ?? 1).toFixed(2)}×</Label>
                <div className="flex items-center gap-1 mt-1">
                  {[0.5, 1, 1.5, 2].map((sp) => (
                    <button
                      key={sp}
                      onClick={() => { pushHistory(); setClipSpeed(selClip.id, sp); }}
                      className={`flex-1 py-1 text-[11px] rounded border ${Math.abs((selClip.speed ?? 1) - sp) < 0.01 ? 'border-primary text-primary bg-primary-container/20' : 'border-outline-variant/40 text-on-surface-variant'}`}
                    >
                      {sp}×
                    </button>
                  ))}
                </div>
                <input type="range" min={25} max={400} step={5} value={Math.round((selClip.speed ?? 1) * 100)} onPointerDown={pushHistory} onChange={(e) => setClipSpeed(selClip.id, Number(e.target.value) / 100)} className="w-full mt-1 accent-primary" />

                {/* clip audio */}
                <div className="flex items-center justify-between mt-3 mb-1">
                  <Label>Volume: {selClip.muted ? 'muted' : `${Math.round((selClip.volume ?? 1) * 100)}%`}</Label>
                  <button onClick={() => toggleClipMute(selClip.id)} title={selClip.muted ? 'Unmute clip' : 'Mute clip'} className={`material-symbols-outlined text-[18px] ${selClip.muted ? 'text-error' : 'text-on-surface-variant hover:text-on-surface'}`}>
                    {selClip.muted ? 'volume_off' : 'volume_up'}
                  </button>
                </div>
                <input type="range" min={0} max={200} value={Math.round((selClip.volume ?? 1) * 100)} disabled={selClip.muted} onPointerDown={pushHistory} onChange={(e) => setClipVolume(selClip.id, Number(e.target.value) / 100)} className="w-full accent-primary disabled:opacity-40" />

                {/* transition into this clip */}
                <div className="mt-3">
                  <Label>Enters with</Label>
                  <Select
                    value={selClip.enter ?? 'cut'}
                    title={ENTER_HELP[selClip.enter ?? 'cut']}
                    onChange={(v) => setClipEnter(selClip.id, v === 'cut' ? undefined : v === 'pack' ? packKind : (v as Enter))}
                    options={[...ENTERS.map((k) => ({value: k, label: k === 'cut' ? 'cut (plain)' : k, title: ENTER_HELP[k]})), {value: 'pack', label: `pack (${packKind})`, title: ENTER_HELP.pack}]}
                  />
                </div>

                {/* J/L cuts */}
                <div className="grid grid-cols-2 gap-2 mt-3">
                  <div title="J-cut: this clip's audio starts this many seconds early, under the previous clip's tail">
                    <Label>J-cut (s){placedSel && placedSel.jFrames / meta.fps < (selClip.jSec ?? 0) - 0.02 ? ` · clamped ${(placedSel.jFrames / meta.fps).toFixed(2)}` : ''}</Label>
                    <NumberInput value={selClip.jSec ?? 0} min={0} max={4} step={0.1} onChange={(v) => setClipAudioCut(selClip.id, {jSec: Math.min(4, Math.max(0, v))})} />
                  </div>
                  <div title="L-cut: this clip's audio keeps playing this many seconds after its picture ends, under the next clip">
                    <Label>L-cut (s){placedSel && placedSel.lFrames / meta.fps < (selClip.lSec ?? 0) - 0.02 ? ` · clamped ${(placedSel.lFrames / meta.fps).toFixed(2)}` : ''}</Label>
                    <NumberInput value={selClip.lSec ?? 0} min={0} max={4} step={0.1} onChange={(v) => setClipAudioCut(selClip.id, {lSec: Math.min(4, Math.max(0, v))})} />
                  </div>
                </div>

                {/* the footage, as the user says it is (set_clip graded / location) */}
                <div className="grid grid-cols-2 gap-2 mt-3">
                  <div title="Already graded = it carries the client's grade (don't regrade it); needs grading = color it. Validate warns when a source's grade starts a few frames into a shot (half-graded).">
                    <Label>Grade</Label>
                    <Select value={selClip.graded == null ? '' : String(selClip.graded)} onChange={(v) => setClipTags(selClip.id, {graded: v === '' ? null : v === 'true'})}
                      options={[{value: '', label: 'not said'}, {value: 'true', label: 'already graded'}, {value: 'false', label: 'needs grading'}]} />
                  </div>
                  <div title="Where it was shot: the render judge never compares the color of clips of two locations">
                    <Label>Location</Label>
                    <input key={`${selClip.id}|${selClip.location ?? ''}`} defaultValue={selClip.location ?? ''} maxLength={60} placeholder="—"
                      onBlur={(e) => { if (e.target.value.trim() !== (selClip.location ?? '')) setClipTags(selClip.id, {location: e.target.value}); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                      className="w-full bg-surface-container-lowest text-on-surface border border-outline-variant/40 focus:border-primary focus:outline-none rounded px-2 py-1 text-[12px]" />
                  </div>
                </div>

                {/* which part of its variant (set_clip piece): Sync body copies what sits on the body */}
                <div className="mt-3" title="Which part of its variant this clip is: Sync body (below) copies what sits on the body clips to the family's other variants; their hooks and CTAs stay theirs">
                  <Label>Piece</Label>
                  <Select value={selClip.piece ?? ''} onChange={(v) => setClipTags(selClip.id, {piece: v === '' ? null : (v as Piece)})}
                    options={[{value: '', label: `not said${(() => { const k = inferPieces(clips, validateIdentity(identity).identity?.variant).find((c) => c.id === selClip.id)?.piece; return k ? ` (${k} by the identity)` : ''; })()}`}, ...PIECES.map((k) => ({value: k, label: k}))]} />
                </div>

                {/* speed ramp */}
                <div className="mt-3" title="The clip becomes pieces whose speed eases from → to (1 → 2.5 rushes a walk-through, 2 → 1 lands on a reveal). Pieces start plain: add transitions after.">
                  <Label>Speed ramp</Label>
                  <div className="grid grid-cols-4 gap-1 mt-1 items-end">
                    <NumberInput value={ramp.from} min={0.25} max={4} step={0.25} title="from ×" onChange={(from) => setRamp({...ramp, from})} />
                    <NumberInput value={ramp.to} min={0.25} max={4} step={0.25} title="to ×" onChange={(to) => setRamp({...ramp, to})} />
                    <Select value={String(ramp.steps)} title="pieces" onChange={(v) => setRamp({...ramp, steps: Number(v)})} options={[2, 3, 4, 5, 6].map((n) => ({value: String(n), label: `${n} pc`}))} />
                    <Btn onClick={() => { applySpeedRamp(selClip.id, ramp.from, ramp.to, ramp.steps); notify(`Speed ramp ${ramp.from}× → ${ramp.to}×`, 'ok'); }} disabled={!rampOk} title={rampOk ? '' : 'clip too short for that many pieces (0.3 s each)'}>Apply</Btn>
                  </div>
                </div>
                <p className="text-[11px] text-on-surface-variant/60 mt-3">Drag the clip's edges on the Video track to trim. Keyframe button on the preview to zoom/pan.</p>
              </div>
            ) : (
              <p className="text-body-sm text-on-surface-variant/60">Select a clip on the timeline, in the Assets panel or in the preview.</p>
            )}

            <Section title="Transitions (all clips)" hint="Punch every other jump cut inside each take, or reset every clip to a plain cut.">
              <div className="flex gap-2">
                <Btn onClick={() => { setTransitionPattern('punch-alternate'); notify('Punch on alternate jump cuts', 'ok'); }} disabled={!clips.length} className="flex-1">Punch alternate</Btn>
                <Btn onClick={() => setTransitionPattern('none')} disabled={!clips.some((c) => c.enter)} className="flex-1">All plain cuts</Btn>
              </div>
            </Section>
            {family && (
              <Section title={`Family ${family}`} hint="sync_family: this variant's body (the body pieces: pages, graphics, B-roll, grade overrides, clip audio) onto the other variants of the script, on their own timelines; their hooks and CTAs stay theirs. A graphic whose data a sibling's audio does not say stays behind.">
                <div className="flex gap-1">
                  <TextInput value={syncExcept} onChange={setSyncExcept} placeholder="except: project ids, comma-separated" />
                  <Btn onClick={syncBody} disabled={syncing || !clips.length} className="whitespace-nowrap">{syncing ? '…' : 'Sync body'}</Btn>
                </div>
              </Section>
            )}
          </div>
        )}

        {tab === 'Captions' && (
          <>
            <button
              onClick={onGenerate}
              disabled={generating || !clips.length}
              className="w-full py-3 bg-primary-container text-on-primary-container rounded-lg font-bold text-body-md hover:brightness-110 disabled:opacity-40 transition-all flex items-center justify-center gap-2"
            >
              <span className={`material-symbols-outlined text-[20px] ${generating ? 'animate-spin' : ''}`}>{generating ? 'progress_activity' : 'auto_awesome'}</span>
              {generating ? 'Generating…' : 'Generate AI Captions'}
            </button>
            {generating && <p className="text-[11px] text-on-surface-variant mt-2 truncate">{progressLabel}</p>}
            <div className="flex gap-2 mt-2 mb-3" title="A hand-typed page on the clip under the playhead (2 s)">
              <input
                value={pageText}
                onChange={(e) => setPageText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPage(); } }}
                disabled={!clips.length}
                placeholder="Caption text (2 s at the playhead)"
                aria-label="Caption text for a new page at the playhead"
                className="flex-1 min-w-0 bg-surface-container-lowest text-on-surface border border-outline-variant/40 focus:border-primary focus:outline-none rounded px-2 py-1 text-[12px] disabled:opacity-40"
              />
              <Btn onClick={addPage} disabled={!clips.length || !pageText.trim()}><span className="material-symbols-outlined text-[16px]">add</span>Add</Btn>
            </div>
            <div className="flex items-center justify-between mb-5" title="set_captions: the pages are kept, none is rendered (a reel without subtitles)">
              <Label>{captionsOff ? 'Captions off — not rendered' : 'Show captions'}</Label>
              <Toggle on={!captionsOff} onChange={(on) => setCaptionsOff(!on)} />
            </div>
            {/* set_captions face_shift / face_hold (src/faces.ts): how far and how long a position holds to clear every face; the pages re-place, their words stay */}
            <div className="mb-5" title="set_captions face_shift: how far (± % of the height) the captions may move from the pack's position so they never cover a face — 0 = never move (Validate reports it). Pages placed by hand stay">
              <Label>Cuánto puede moverse para no tapar caras (±{knobs.shift}%)</Label>
              <input type="range" min={0} max={66} step={1} value={knobs.shift} onChange={(e) => setFaceKnobs({faceShift: Number(e.target.value)})} aria-label="Cuánto puede moverse para no tapar caras (±%)" className="w-full mt-1 mb-2 accent-primary" />
              <div className="flex items-center gap-2" title="set_captions face_hold: one position per take (never moves inside it), for the whole reel, or per page (the most free)">
                <Label>Posición</Label>
                <Select value={knobs.hold} onChange={(v) => setFaceKnobs({faceHold: v as FaceHold})} options={[{value: 'toma', label: 'por toma'}, {value: 'video', label: 'por video'}, {value: 'pagina', label: 'por página'}]} />
                {faceShift != null || faceHold != null ? <Btn onClick={() => setFaceKnobs({faceShift: null, faceHold: null})}>Kit</Btn> : null}
              </div>
            </div>
            <div className="mb-5" title="set_guion: generated captions take the script's wording where it aligns with the audio (ASR timing kept); where they disagree the audio stays and Validate reports it">
              <Label>Guion (client script)</Label>
              <textarea
                value={guion}
                onChange={(e) => setGuion(e.target.value)}
                rows={guion ? Math.min(10, guion.split('\n').length + 1) : 2}
                placeholder="Paste the script. Regenerate captions to reconcile them with it."
                className="w-full bg-surface-container-lowest text-on-surface border border-outline-variant/40 focus:border-primary focus:outline-none rounded p-2 text-[12px] resize-y"
              />
            </div>

            {!captions.length ? (
              <p className="text-body-sm text-on-surface-variant/60">
                No captions yet. Trim your cut, then hit <span className="text-primary">Generate AI Captions</span>.
              </p>
            ) : (
              <div className="space-y-2">
                {projCaps.map((c) => {
                  const sel = c.id === selectedId;
                  const text = c.words.map((w) => w.text).join(' ');
                  // the stored page and its neighbor: the page break moves between them (edit_caption starts_at_wid)
                  const page = captions.find((x) => x.id === c.id);
                  const prev = sel && page ? pageBefore(captions, page, clips, meta.fps) : undefined; // only the selected page shows the buttons
                  const take = prev && prev.words.length > 1 ? prev.words[prev.words.length - 1].wid : undefined;
                  const give = prev && page && page.words.length > 1 ? page.words[1].wid : undefined;
                  return (
                    <div
                      key={`${c.id}@${c.startMs}`}
                      onClick={() => { select(c.id); seekMs(c.startMs + 20); }}
                      className={`p-3 rounded cursor-pointer transition-colors relative ${sel ? 'bg-surface-variant/40 border-2 border-primary' : 'bg-surface-variant/20 border border-outline-variant/30 hover:border-primary/30'}`}
                    >
                      {sel && <div className="absolute -left-[1px] top-0 bottom-0 w-1 bg-primary rounded-l" />}
                      <div className="flex justify-between items-center mb-1">
                        <span className={`text-[10px] font-mono ${sel ? 'text-primary' : 'text-on-surface-variant'}`}>{fmtSec(c.startMs)} – {fmtSec(c.endMs)}{c.behind ? ' · behind' : ''}</span>
                        {sel && <IconBtn icon="delete" title="Delete page (its words stay uncaptioned)" danger onClick={() => deleteCaption(c.id)} />}
                      </div>

                      {sel ? (
                        <div onClick={(e) => e.stopPropagation()}>
                          {/* applied on blur: typed live, the words re-split on every key and a space could never be typed */}
                          <textarea
                            key={text}
                            defaultValue={text}
                            onFocus={pushHistory}
                            onBlur={(e) => e.target.value !== text && setText(c.id, e.target.value)}
                            rows={2}
                            className="w-full mt-1 mb-3 bg-surface-container-lowest text-on-surface border border-outline-variant/40 focus:border-primary focus:outline-none rounded p-2 text-body-md resize-y"
                          />
                          <Label>Page start · timing</Label>
                          <div className="flex gap-1.5 mt-1 mb-3">
                            <Btn disabled={!take} title={prev ? `Take "${prev.words[prev.words.length - 1].text}" from the page before` : 'First page'} onClick={() => take && movePage(c.id, take)}>◂ word</Btn>
                            <Btn disabled={!give} title={give ? `Give "${page?.words[0].text}" to the page before` : 'No page before, or a retyped page'} onClick={() => give && movePage(c.id, give)}>word ▸</Btn>
                            <Btn title="The page 0.1 s earlier" onClick={() => shiftCaption(c.id, -100)}>−0.1 s</Btn>
                            <Btn title="The page 0.1 s later" onClick={() => shiftCaption(c.id, 100)}>+0.1 s</Btn>
                          </div>
                          <Label>Vertical position: {c.topPct}%</Label>
                          <input type="range" min={5} max={88} value={c.topPct} onPointerDown={pushHistory} onChange={(e) => setTopPct(c.id, Number(e.target.value))} className="w-full mt-1 mb-3 accent-primary" />
                          <div className="flex items-center justify-between mb-3" title="Big words over the head and shoulders; needs a person matte (Settings → Prepare mattes)">
                            <Label>Behind the presenter</Label>
                            <Toggle on={!!c.behind} onChange={(on) => setCaptionBehind(c.id, on)} />
                          </div>
                          <Label>Emphasis (click a word: accent → big → off · right-click: emoji)</Label>
                          <div className="flex flex-wrap gap-1.5 mt-1.5">
                            {c.words.map((w, i) => (
                              <button
                                key={i}
                                onClick={() => { pushHistory(); toggleAccent(c.id, i); }}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  const v = window.prompt(`Emoji after "${w.text}" (empty removes it)`, w.emoji ?? '');
                                  if (v == null) return;
                                  pushHistory(); setEmoji(c.id, i, v.trim());
                                }}
                                style={w.tier ? {background: accentColor, borderColor: accentColor, color: '#000'} : undefined}
                                className={`px-2 py-1 rounded text-[12px] border ${w.tier ? 'font-bold' : 'border-outline-variant/40 bg-surface-container-lowest text-on-surface-variant'}`}
                              >
                                {w.text}{w.tier === 2 ? ' ↑' : ''}{w.emoji ? ` ${w.emoji}` : ''}
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <p className="text-body-sm text-on-surface-variant truncate">{text}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {tab === 'B-roll' && (
          <div className="space-y-5">
            <Section title="Add at playhead" hint={assets.length ? 'Your own footage first (Assets panel or the library).' : 'Add your footage in the Assets panel; stock below is the fallback.'}>
              {assets.length > 0 && (
                <>
                  <Select value={newCue.asset || assets[0].id} onChange={(asset) => setNewCue({...newCue, asset})} options={assets.map((a) => ({value: a.id, label: `${a.kind === 'video' ? '🎬' : '🖼'} ${a.label}`}))} />
                  <div className="grid grid-cols-3 gap-1 items-end">
                    <Select value={newCue.mode} onChange={(m) => setNewCue({...newCue, mode: m as BrollItem['mode']})} options={MODES.map((m) => ({value: m}))} />
                    <NumberInput value={newCue.sec} min={0.3} max={8} step={0.5} title="seconds" onChange={(sec) => setNewCue({...newCue, sec})} />
                    <Btn primary onClick={addCue} disabled={!clips.length}>Add</Btn>
                  </div>
                </>
              )}
            </Section>
            <BrollSuggestions library={library} mode={newCue.mode} notify={notify} onStockQuery={(q) => setStockQuery(q)} />
            <StockSearch key={stockQuery ?? ''} initialQuery={stockQuery} notify={notify} />

            {!brolls.length ? (
              <p className="text-body-sm text-on-surface-variant/60">No B-roll yet.</p>
            ) : (
              <div className="space-y-2">
                {projBrolls.map((b) => {
                  const isSel = b.id === selectedId;
                  return (
                    <div
                      key={b.id}
                      onClick={() => { select(b.id); seekMs(b.startMs + 20); }}
                      className={`p-3 rounded cursor-pointer transition-colors ${isSel ? 'bg-surface-variant/40 border-2 border-primary' : 'bg-surface-variant/20 border border-outline-variant/30 hover:border-primary/30'}`}
                    >
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-[10px] font-mono text-on-surface-variant">{fmtSec(b.startMs)} – {fmtSec(b.endMs)}</span>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded uppercase ${b.source === 'own' ? 'bg-secondary-container/40 text-secondary' : 'bg-tertiary-container/40 text-tertiary'}`}>{b.source ?? 'pexels'}</span>
                      </div>
                      <p className="text-body-sm text-on-surface truncate mb-2">{b.query ?? b.id}</p>
                      <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-1">
                        {MODES.map((m) => (
                          <button key={m} onClick={() => setBrollMode(b.id, m)} className={`flex-1 py-1 text-[10px] rounded border ${b.mode === m ? 'border-primary text-primary bg-primary-container/20' : 'border-outline-variant/40 text-on-surface-variant'}`}>
                            {m === 'fullscreen' ? 'Full' : m === 'carousel' ? 'Caro' : m[0].toUpperCase() + m.slice(1)}
                          </button>
                        ))}
                        {!!b.alternatives?.length && <button onClick={() => swapBroll(b.id)} title="Next option" className="material-symbols-outlined text-[18px] text-on-surface-variant hover:text-primary px-1">cached</button>}
                        <button onClick={() => removeBroll(b.id)} title="Remove" className="material-symbols-outlined text-[18px] text-on-surface-variant hover:text-error px-1">delete</button>
                      </div>
                      {isSel && (
                        <div onClick={(e) => e.stopPropagation()} className="grid grid-cols-2 gap-2 mt-3">
                          <div><Label>Arrives</Label><Select value={b.arrive ?? 'cut'} onChange={(v) => setBrollMotion(b.id, {arrive: v as BrollIn})} options={ARRIVES.map((a) => ({value: a}))} /></div>
                          <div><Label>Leaves</Label><Select value={b.leave ?? 'cut'} onChange={(v) => setBrollMotion(b.id, {leave: v as BrollOut})} options={LEAVES.map((a) => ({value: a}))} /></div>
                          <div><Label>Start (s)</Label><NumberInput value={+(b.startMs / 1000).toFixed(2)} min={0} step={0.1} onChange={(v) => setBrollTiming(b.id, {startSec: v})} /></div>
                          <div><Label>End (s)</Label><NumberInput value={+(b.endMs / 1000).toFixed(2)} min={0} step={0.1} onChange={(v) => setBrollTiming(b.id, {endSec: v})} /></div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {tab === 'Graphics' && <GraphicsTab playerRef={playerRef} notify={notify} />}
        {tab === 'Styles' && <StylesTab onStyleChange={onStyleChange} notify={notify} />}
        {tab === 'Settings' && <SettingsTab notify={notify} />}
      </div>
    </aside>
  );
};
