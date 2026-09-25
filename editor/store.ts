import {create} from 'zustand';
import {playedSpans, retext, setPageStart, shiftPage, type Caption} from '../src/captions';
import type {BrollItem, BrollAsset} from '../src/Broll';
import type {PresetId} from '../src/captionPresets';
import type {Graphic} from '../src/graphicTemplates';
import type {Matte} from '../src/Person';
import type {Brand} from '../src/brand';
import type {ProjectGrade} from '../src/grade';
import {applyAutocut as autocutClips, locateSec, nextId, placeClips, reanchor, splitClip, totalDurationFrames, type Clip, type Music} from '../src/timeline';
import {punchAlternate, speedRamp, type Enter} from '../src/transitions';
import type {BrollIn, BrollOut} from '../src/motion';
import {TEMPLATES, type Life, type Out, type Reveal, type TemplateId} from '../src/graphicTemplates';
import {DEFAULT_TOP} from '../src/paging';
import {applyWordCuts, planWordCuts, type CutRange, type TClip} from '../src/cuts';
import type {AudioOptions} from '../src/audio';

export type Meta = {durationInFrames: number; fps: number; width: number; height: number};
// what a project file holds (besides name/timestamps)
export type ProjectData = {clips: Clip[]; music: Music; captions: Caption[]; brolls: BrollItem[]; graphics: Graphic[]; mattes: Matte[]; brollAssets: BrollAsset[]; accentColor: string; lang: Lang; captionStyle: PresetId; offMic: OffMic; hiddenWids: string[]; brand: Brand | null; grade: ProjectGrade | null; audio: AudioOptions; plan: string; captionsOff: boolean};
export type Lang = 'auto' | 'es' | 'en';
// a quieter second voice away from the mic (a director feeding lines): flag it in the transcript, cut it, or ignore it
export type OffMic = 'mark' | 'cut' | 'off';

const HISTORY_LIMIT = 100;

// one undo step = the full editable state
type Snapshot = {clips: Clip[]; music: Music; captions: Caption[]; brolls: BrollItem[]; graphics: Graphic[]};

type EditorState = {
  meta: Meta | null;
  projectId: string | null;
  projectName: string;
  captions: Caption[];
  clips: Clip[];
  music: Music;
  brolls: BrollItem[];
  graphics: Graphic[];
  mattes: Matte[];
  brollAssets: BrollAsset[];
  accentColor: string;
  captionStyle: PresetId;
  selectedId: string | null;
  selectedClipId: string | null;
  currentFrame: number;
  lang: Lang; // transcription language for this project
  offMic: OffMic;
  hiddenWids: string[]; // transcript words whose caption pages were deleted — never re-paged
  brand: Brand | null; // client kit (set_brand / Styles tab)
  grade: ProjectGrade | null; // color (set_grade / Styles tab)
  audio: AudioOptions; // voice cleanup + sfx (set_audio / Settings tab)
  plan: string; // the agent's editorial plan (set_plan); shown and editable in Settings
  captionsOff: boolean; // captions switched off (set_captions): pages kept, none rendered

  // undo/redo: снапшоты ВСЕГО редактируемого состояния (clips/music/captions/brolls).
  // Толкаем ОДИН раз в начале логической правки — драг не флудит историю.
  past: Snapshot[];
  future: Snapshot[];

  init: (meta: Meta, p?: Partial<ProjectData>) => void;
  addBrollAsset: (asset: BrollAsset) => void;
  removeBrollAsset: (id: string) => void;
  select: (id: string | null) => void;
  setCurrentFrame: (f: number) => void;
  setTopPct: (id: string, topPct: number) => void;
  setCaptionScale: (id: string, scale: number) => void;
  setBrollScale: (id: string, scale: number) => void;
  setText: (id: string, text: string) => void;
  movePageStart: (id: string, wid: string) => void; // edit_caption starts_at_wid
  shiftCaption: (id: string, ms: number) => void; // edit_caption shift_ms
  toggleAccent: (id: string, wordIndex: number) => void;
  setEmoji: (id: string, wordIndex: number, emoji: string) => void;
  setCaptionBehind: (id: string, behind: boolean) => void;
  addCaption: (frame: number, text: string, durationSec?: number) => void;
  deleteCaption: (id: string) => void;

  // clips track (multi-clip timeline)
  addClip: (clip: Clip) => void;
  setClipOrder: (orderedIds: string[]) => void;
  splitClipAtFrame: (frame: number) => void;
  setKeyframe: (clipId: string, t: number, tr: {scale: number; x: number; y: number}) => void;
  removeKeyframe: (clipId: string, t: number) => void;
  applyAutocut: (plan: {id: string; segments: {inSec: number; outSec: number}[]}[]) => void;
  removeClips: (ids: string[]) => void;
  setLang: (lang: Lang) => void;
  setOffMic: (offMic: OffMic) => void;
  selectClip: (id: string | null) => void;
  deleteClip: (id: string) => void;
  moveClip: (id: string, dir: -1 | 1) => void;
  moveClipTo: (id: string, index: number) => void;
  trimClip: (id: string, inSec: number, outSec: number) => void;
  setClipVolume: (id: string, volume: number) => void;
  toggleClipMute: (id: string) => void;
  setClipSpeed: (id: string, speed: number) => void;
  setClipEnter: (id: string, enter: Enter | undefined) => void;
  setClipAudioCut: (id: string, cut: {jSec?: number; lSec?: number}) => void;
  setTransitionPattern: (pattern: 'punch-alternate' | 'none') => void;
  applySpeedRamp: (id: string, from: number, to: number, steps: number) => void;
  cutWords: (tr: TClip[], ranges: CutRange[]) => void; // cut_words: approved word ranges, snapped into the pauses
  setMusic: (music: Music) => void;
  setAccentColor: (color: string) => void;
  setCaptionStyle: (style: PresetId) => void;
  setCaptions: (captions: Caption[]) => void;
  setProjectInfo: (id: string, name: string) => void;
  setProjectName: (name: string) => void;

  // b-roll
  setBrolls: (brolls: BrollItem[]) => void;
  removeBroll: (id: string) => void;
  setBrollMode: (id: string, mode: BrollItem['mode']) => void;
  swapBroll: (id: string) => void;
  setBrollMotion: (id: string, m: {arrive?: BrollIn; leave?: BrollOut}) => void;
  setBrollTiming: (id: string, t: {startSec?: number; endSec?: number}) => void;
  addBroll: (frame: number, b: {src: string; kind: BrollItem['kind']; mode: BrollItem['mode']; durationSec: number; source?: BrollItem['source']; query?: string; assetId?: string}) => void;

  // graphics (source-anchored, like captions)
  addGraphic: (frame: number, g: {template: TemplateId; props: Record<string, unknown>; durationSec?: number; yPct?: number; behind?: boolean; reveal?: Reveal; out?: Out; life?: Life; camera?: Graphic['camera']}) => void;
  editGraphic: (id: string, patch: Partial<Pick<Graphic, 'props' | 'yPct' | 'behind' | 'reveal' | 'out' | 'life' | 'camera'>> & {startSec?: number; durationSec?: number}) => void;
  removeGraphic: (id: string) => void;

  // project-wide settings (no undo, like accent and style)
  setBrand: (brand: Brand | null) => void;
  setGrade: (grade: ProjectGrade | null) => void;
  setAudio: (audio: AudioOptions) => void;
  setCaptionsOff: (captionsOff: boolean) => void;
  setPlan: (plan: string) => void;
  addMattes: (mattes: Matte[]) => void;

  pushHistory: () => void;
  undo: () => void;
  redo: () => void;
};

// recompute timeline length in frames from the current clips
const withMeta = (meta: Meta | null, clips: Clip[]): Meta | null =>
  meta ? {...meta, durationInFrames: totalDurationFrames(clips, meta.fps)} : meta;

// capture the undoable slice of state
type Snappable = {clips: Clip[]; music: Music; captions: Caption[]; brolls: BrollItem[]; graphics: Graphic[]};
const snap = (s: Snappable): Snapshot => ({clips: s.clips, music: s.music, captions: s.captions, brolls: s.brolls, graphics: s.graphics});
// returns the {past, future} patch to prepend to a mutation that should be undoable
const withHistory = (s: Snappable & {past: Snapshot[]}) => ({
  past: [...s.past, snap(s)].slice(-HISTORY_LIMIT),
  future: [] as Snapshot[],
});

const mapCap = (caps: Caption[], id: string, fn: (c: Caption) => Caption) =>
  caps.map((c) => (c.id === id ? fn(c) : c));
// the clip under the playhead and the source time there (null with no clips)
const atFrame = (s: {clips: Clip[]; meta: Meta | null}, frame: number) => (s.meta ? locateSec(s.clips, s.meta.fps, frame / s.meta.fps) : null);

export const useEditor = create<EditorState>((set) => ({
  meta: null,
  projectId: null,
  projectName: 'Untitled project',
  captions: [],
  clips: [],
  music: null,
  brolls: [],
  graphics: [],
  mattes: [],
  brollAssets: [],
  accentColor: '#FFB020',
  captionStyle: 'palabra',
  selectedId: null,
  selectedClipId: null,
  currentFrame: 0,
  lang: 'auto',
  offMic: 'mark',
  hiddenWids: [],
  brand: null,
  grade: null,
  audio: null,
  plan: '',
  captionsOff: false,
  past: [],
  future: [],

  init: (meta, p = {}) =>
    set((s) => {
      const clips = p.clips ?? [];
      return {
        meta: withMeta(meta, clips),
        projectId: null, // caller assigns via setProjectInfo — prevents autosaving a cleared state into the old project
        projectName: 'Untitled project',
        captions: p.captions ?? [],
        clips,
        music: p.music ?? null,
        brolls: p.brolls ?? [],
        graphics: p.graphics ?? [],
        mattes: p.mattes ?? [],
        brollAssets: p.brollAssets ?? [],
        accentColor: p.accentColor ?? s.accentColor,
        lang: p.lang ?? 'auto',
        captionStyle: p.captionStyle ?? 'palabra',
        offMic: p.offMic ?? 'mark',
        hiddenWids: p.hiddenWids ?? [],
        brand: p.brand ?? null,
        grade: p.grade ?? null,
        audio: p.audio ?? null,
        plan: p.plan ?? '',
        captionsOff: p.captionsOff ?? false,
        past: [],
        future: [],
      };
    }),
  addBrollAsset: (asset) => set((s) => ({brollAssets: [...s.brollAssets, asset]})),
  removeBrollAsset: (id) => set((s) => ({brollAssets: s.brollAssets.filter((a) => a.id !== id)})),
  select: (id) => set({selectedId: id, selectedClipId: null}),
  setCurrentFrame: (f) => set({currentFrame: f}),

  setTopPct: (id, topPct) => set((s) => ({captions: mapCap(s.captions, id, (c) => ({...c, topPct, pin: true}))})),
  setCaptionScale: (id, scale) => set((s) => ({captions: mapCap(s.captions, id, (c) => ({...c, scale}))})),
  setBrollScale: (id, scale) => set((s) => ({brolls: s.brolls.map((b) => (b.id === id ? {...b, scale} : b))})),

  // the page's text, the way edit_caption does it (src/captions.ts retext)
  setText: (id, text) => set((s) => ({captions: mapCap(s.captions, id, (c) => (text.trim() ? retext(c, text, playedSpans(c, s.clips)) : c))})), // the text box shows the words that play
  movePageStart: (id, wid) => set((s) => ({...withHistory(s), captions: setPageStart(s.captions, id, wid)})),
  shiftCaption: (id, ms) => set((s) => ({...withHistory(s), captions: mapCap(s.captions, id, (c) => shiftPage(c, ms))})),

  setEmoji: (id, wi, emoji) =>
    set((s) => ({
      captions: mapCap(s.captions, id, (c) => ({...c, words: c.words.map((w, i) => (i !== wi ? w : emoji ? {...w, emoji} : (({emoji: _, ...rest}) => rest)(w)))})),
    })),
  setCaptionBehind: (id, behind) =>
    set((s) => ({...withHistory(s), captions: mapCap(s.captions, id, (c) => (behind ? {...c, behind: true} : (({behind: _, ...rest}) => rest)(c)))})),
  // a hand-typed page on the clip under the playhead (delete_captions / add_caption semantics)
  addCaption: (frame, text, durationSec = 2) =>
    set((s) => {
      const at = atFrame(s, frame);
      if (!at || !text.trim()) return s;
      const startMs = Math.round(at.sourceSec * 1000);
      const endMs = Math.round(Math.min(at.clip.outSec, at.sourceSec + durationSec * (at.clip.speed ?? 1)) * 1000);
      const topPct = s.captions.find((c) => c.src === at.clip.src)?.topPct ?? DEFAULT_TOP;
      const cap = retext({id: nextId(s.captions, 'c'), src: at.clip.src, startMs, endMs, topPct, words: []}, text);
      return {...withHistory(s), captions: [...s.captions, cap], selectedId: cap.id, selectedClipId: null};
    }),
  deleteCaption: (id) =>
    set((s) => {
      const cap = s.captions.find((c) => c.id === id);
      if (!cap) return s;
      const wids = cap.words.map((w) => w.wid).filter((w): w is string => !!w);
      return {...withHistory(s), captions: s.captions.filter((c) => c.id !== id), hiddenWids: [...new Set([...s.hiddenWids, ...wids])], selectedId: s.selectedId === id ? null : s.selectedId};
    }),
  toggleAccent: (id, wi) =>
    set((s) => ({
      captions: mapCap(s.captions, id, (c) => ({
        ...c,
        words: c.words.map((w, i) => (i === wi ? {...w, tier: ((w.tier ?? 0) + 1) % 3} : w)),
      })),
    })),

  // ---- clips track ----
  addClip: (clip) =>
    set((s) => {
      const clips = [...s.clips, clip];
      return {...withHistory(s), clips, meta: withMeta(s.meta, clips), selectedClipId: clip.id};
    }),
  // reorder clips to match an explicit id order (unknown ids appended, missing kept)
  setClipOrder: (orderedIds) =>
    set((s) => {
      const byId = new Map(s.clips.map((c) => [c.id, c]));
      const ordered = orderedIds.map((id) => byId.get(id)).filter(Boolean) as typeof s.clips;
      const rest = s.clips.filter((c) => !orderedIds.includes(c.id));
      return {...withHistory(s), clips: [...ordered, ...rest]};
    }),
  // split the clip under the playhead into two; re-anchor captions/b-roll so the
  // second half keeps its overlays. Enables cutting moments out (split twice → delete middle).
  splitClipAtFrame: (frame) =>
    set((s) => {
      if (!s.meta) return s;
      const fps = s.meta.fps;
      const hit = placeClips(s.clips, fps).find((p) => frame > p.fromFrame + 1 && frame < p.fromFrame + p.durFrames - 1);
      if (!hit) return s;
      const clip = hit.clip;
      const splitSrc = clip.inSec + ((frame - hit.fromFrame) / fps) * (clip.speed ?? 1); // source-time of the cut
      const r = splitClip(s.clips, clip.id, splitSrc);
      if (!r) return s; // too short
      // captions are source-anchored and follow on their own; B-roll is clip-bound
      return {...withHistory(s), clips: r.clips, brolls: reanchor(s.brolls, r.remap), meta: withMeta(s.meta, r.clips), selectedClipId: r.newId};
    }),

  // autocut: replace clips with their speech segments (ends + internal pauses
  // removed). Captions follow by source time; B-roll is re-anchored. One undo step.
  applyAutocut: (plan) =>
    set((s) => {
      const r = autocutClips(s.clips, plan);
      return {...withHistory(s), clips: r.clips, brolls: reanchor(s.brolls, r.remap), meta: withMeta(s.meta, r.clips)};
    }),

  // upsert a keyframe at source-time t (no history — caller pushes once per gesture)
  setKeyframe: (clipId, t, tr) =>
    set((s) => ({
      clips: s.clips.map((c) => {
        if (c.id !== clipId) return c;
        const kfs = (c.transform ?? []).slice();
        const idx = kfs.findIndex((k) => Math.abs(k.t - t) < 0.06);
        const kf = {t, ...tr};
        if (idx >= 0) kfs[idx] = kf;
        else { kfs.push(kf); kfs.sort((a, b) => a.t - b.t); }
        return {...c, transform: kfs};
      }),
    })),
  removeKeyframe: (clipId, t) =>
    set((s) => ({
      ...withHistory(s),
      clips: s.clips.map((c) => (c.id === clipId ? {...c, transform: (c.transform ?? []).filter((k) => Math.abs(k.t - t) >= 0.06)} : c)),
    })),

  // remove several clips in ONE undo step
  removeClips: (ids) =>
    set((s) => {
      const del = new Set(ids);
      const clips = s.clips.filter((c) => !del.has(c.id));
      return {...withHistory(s), clips, meta: withMeta(s.meta, clips), selectedClipId: del.has(s.selectedClipId ?? '') ? null : s.selectedClipId};
    }),
  setLang: (lang) => set({lang}),
  setOffMic: (offMic) => set({offMic}),
  selectClip: (id) => set({selectedClipId: id, selectedId: null}),

  deleteClip: (id) =>
    set((s) => {
      const clips = s.clips.filter((c) => c.id !== id);
      return {...withHistory(s), clips, meta: withMeta(s.meta, clips), selectedClipId: s.selectedClipId === id ? null : s.selectedClipId};
    }),

  // reorder by swapping with the neighbour in `dir` (-1 left, +1 right)
  moveClip: (id, dir) =>
    set((s) => {
      const i = s.clips.findIndex((c) => c.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= s.clips.length) return s;
      const clips = s.clips.slice();
      [clips[i], clips[j]] = [clips[j], clips[i]];
      return {...withHistory(s), clips};
    }),

  // drag-reorder: move a clip to `index` (position within the list WITHOUT the clip)
  moveClipTo: (id, index) =>
    set((s) => {
      const i = s.clips.findIndex((c) => c.id === id);
      if (i < 0) return s;
      const without = s.clips.filter((c) => c.id !== id);
      const idx = Math.max(0, Math.min(index, without.length));
      if (idx === i) return s; // dropped back into the same slot
      const clips = [...without.slice(0, idx), s.clips[i], ...without.slice(idx)];
      return {...withHistory(s), clips, meta: withMeta(s.meta, clips)};
    }),

  // trim in/out (sec), clamped to [0, sourceDuration] with a 0.2s min length
  trimClip: (id, inSec, outSec) =>
    set((s) => {
      const clips = s.clips.map((c) => {
        if (c.id !== id) return c;
        const lo = Math.max(0, Math.min(inSec, c.sourceDurationSec - 0.2));
        const hi = Math.min(c.sourceDurationSec, Math.max(outSec, lo + 0.2));
        return {...c, inSec: lo, outSec: hi};
      });
      return {clips, meta: withMeta(s.meta, clips)};
    }),

  // clip audio: volume (no per-tick history — UI pushes once per gesture), mute toggle
  setClipVolume: (id, volume) => set((s) => ({clips: s.clips.map((c) => (c.id === id ? {...c, volume} : c))})),
  toggleClipMute: (id) => set((s) => ({...withHistory(s), clips: s.clips.map((c) => (c.id === id ? {...c, muted: !c.muted} : c))})),

  // playback speed (clamped 0.25–4) — timeline repacks since clip duration changes
  setClipSpeed: (id, speed) =>
    set((s) => {
      const sp = Math.min(4, Math.max(0.25, speed));
      const clips = s.clips.map((c) => (c.id === id ? {...c, speed: sp} : c));
      return {clips, meta: withMeta(s.meta, clips)};
    }),

  // how the clip starts (set_transitions items); undefined = plain cut
  setClipEnter: (id, enter) =>
    set((s) => ({...withHistory(s), clips: s.clips.map((c) => (c.id !== id ? c : enter ? {...c, enter} : (({enter: _, ...rest}) => rest)(c)))})),
  // J/L-cut seconds (set_audio_cut); 0 clears. placeClips clamps them at render time
  setClipAudioCut: (id, cut) =>
    set((s) => ({
      ...withHistory(s),
      clips: s.clips.map((c) => {
        if (c.id !== id) return c;
        const n = {...c};
        if (cut.jSec != null) { if (cut.jSec > 0) n.jSec = cut.jSec; else delete n.jSec; }
        if (cut.lSec != null) { if (cut.lSec > 0) n.lSec = cut.lSec; else delete n.lSec; }
        return n;
      }),
    })),
  setTransitionPattern: (pattern) =>
    set((s) => ({...withHistory(s), clips: pattern === 'none' ? s.clips.map(({enter: _, ...c}) => c) : punchAlternate(s.clips)})),
  // set_speed_ramp: the clip becomes `steps` pieces whose speed eases from → to
  applySpeedRamp: (id, from, to, steps) =>
    set((s) => {
      const c = s.clips.find((x) => x.id === id);
      if (!c) return s;
      const speeds = speedRamp(from, to, steps);
      const span = c.outSec - c.inSec;
      if (span / speeds.length < 0.3) return s; // the UI checks this first
      let clips = s.clips, brolls = s.brolls, cur = id;
      const ids = [id];
      for (let k = 1; k < speeds.length; k++) {
        const r = splitClip(clips, cur, c.inSec + (span * k) / speeds.length);
        if (!r) return s;
        clips = r.clips; brolls = reanchor(brolls, r.remap); cur = r.newId; ids.push(cur);
      }
      clips = clips.map((x) => (ids.includes(x.id) ? {...x, speed: speeds[ids.indexOf(x.id)]} : x));
      return {...withHistory(s), clips, brolls, meta: withMeta(s.meta, clips)};
    }),

  cutWords: (tr, ranges) =>
    set((s) => {
      const {spans} = planWordCuts(tr, s.clips, ranges);
      if (!spans.length) return s;
      const r = applyWordCuts(s.clips, s.brolls, spans, tr);
      return {...withHistory(s), clips: r.clips, brolls: r.brolls, meta: withMeta(s.meta, r.clips), selectedClipId: null};
    }),

  // push history only on add/remove (not on every volume/fade slider tick)
  setMusic: (music) =>
    set((s) => {
      const structural = (s.music === null) !== (music === null);
      return {...(structural ? withHistory(s) : {}), music};
    }),
  setAccentColor: (accentColor) => set((s) => ({accentColor, brand: s.brand ? {...s.brand, colors: {...s.brand.colors, accent: accentColor}} : s.brand})),
  setCaptionStyle: (captionStyle) => set({captionStyle}),
  setCaptions: (captions) => set({captions, selectedId: null}),
  setProjectInfo: (projectId, projectName) => set({projectId, projectName}),
  setProjectName: (projectName) => set({projectName}),

  // ---- b-roll ----
  setBrolls: (brolls) => set((s) => ({...withHistory(s), brolls})),
  removeBroll: (id) => set((s) => ({...withHistory(s), brolls: s.brolls.filter((b) => b.id !== id)})),
  setBrollMode: (id, mode) => set((s) => ({...withHistory(s), brolls: s.brolls.map((b) => (b.id === id ? {...b, mode} : b))})),
  // cycle to the next alternative source (Pexels), wrapping around
  swapBroll: (id) =>
    set((s) => ({
      ...withHistory(s),
      brolls: s.brolls.map((b) => {
        if (b.id !== id || !b.alternatives?.length) return b;
        const i = b.alternatives.indexOf(b.src);
        const next = b.alternatives[(i + 1) % b.alternatives.length];
        return {...b, src: next};
      }),
    })),

  setBrollMotion: (id, m) => set((s) => ({...withHistory(s), brolls: s.brolls.map((b) => (b.id === id ? {...b, ...m} : b))})),
  // move / resize a cue in timeline seconds (edit_broll): it stays on one clip
  setBrollTiming: (id, t) =>
    set((s) => {
      const b = s.brolls.find((x) => x.id === id);
      if (!b || !s.meta) return s;
      const n = {...b};
      if (t.startSec != null) {
        const at = locateSec(s.clips, s.meta.fps, t.startSec);
        if (!at) return s;
        const len = n.endMs - n.startMs;
        n.clipId = at.clip.id; n.startMs = Math.round(at.sourceSec * 1000); n.endMs = Math.min(Math.round(at.clip.outSec * 1000), n.startMs + len);
      }
      if (t.endSec != null) {
        const at = locateSec(s.clips, s.meta.fps, t.endSec);
        if (!at || at.clip.id !== n.clipId) return s;
        n.endMs = Math.max(n.startMs + 300, Math.round(at.sourceSec * 1000));
      }
      return {...withHistory(s), brolls: s.brolls.map((x) => (x.id === id ? n : x))};
    }),
  addBroll: (frame, b) =>
    set((s) => {
      const at = atFrame(s, frame);
      if (!at) return s;
      const startMs = Math.round(at.sourceSec * 1000);
      const endMs = Math.round(Math.min(at.clip.outSec, at.sourceSec + b.durationSec * (at.clip.speed ?? 1)) * 1000);
      const cue: BrollItem = {id: nextId(s.brolls, 'b'), clipId: at.clip.id, startMs, endMs, kind: b.kind, mode: b.mode, src: b.src, source: b.source ?? 'own', query: b.query, alternatives: [], ...(b.assetId ? {assetId: b.assetId} : {})} as BrollItem;
      return {...withHistory(s), brolls: [...s.brolls, cue], selectedId: cue.id, selectedClipId: null};
    }),

  // ---- graphics ----
  addGraphic: (frame, g) =>
    set((s) => {
      const at = atFrame(s, frame);
      if (!at) return s;
      const startMs = Math.round(at.sourceSec * 1000);
      const gfx: Graphic = {id: nextId(s.graphics, 'g'), src: at.clip.src, startMs, endMs: startMs + Math.round(g.durationSec ? g.durationSec * 1000 : TEMPLATES[g.template].defaultMs), template: g.template, props: g.props};
      if (g.yPct != null) gfx.yPct = g.yPct;
      if (g.behind) gfx.behind = true;
      if (g.reveal) gfx.reveal = g.reveal; if (g.out) gfx.out = g.out; if (g.life) gfx.life = g.life; if (g.camera) gfx.camera = g.camera;
      return {...withHistory(s), graphics: [...s.graphics, gfx], selectedId: gfx.id, selectedClipId: null};
    }),
  editGraphic: (id, patch) =>
    set((s) => {
      const g = s.graphics.find((x) => x.id === id);
      if (!g) return s;
      const {startSec, durationSec, ...rest} = patch;
      const n: Graphic = {...g, ...rest};
      if (startSec != null && s.meta) {
        const at = locateSec(s.clips, s.meta.fps, startSec);
        if (!at) return s;
        const len = n.endMs - n.startMs;
        n.src = at.clip.src; n.startMs = Math.round(at.sourceSec * 1000); n.endMs = n.startMs + len;
      }
      if (durationSec != null) n.endMs = n.startMs + Math.round(durationSec * 1000);
      if (n.behind === false) delete n.behind;
      return {...withHistory(s), graphics: s.graphics.map((x) => (x.id === id ? n : x))};
    }),
  removeGraphic: (id) => set((s) => ({...withHistory(s), graphics: s.graphics.filter((g) => g.id !== id), selectedId: s.selectedId === id ? null : s.selectedId})),

  // ---- project-wide settings ----
  setBrand: (brand) => set((s) => ({brand, accentColor: brand?.colors.accent ?? s.accentColor})),
  setGrade: (grade) => set({grade}),
  setAudio: (audio) => set({audio}),
  setCaptionsOff: (captionsOff) => set({captionsOff}),
  setPlan: (plan) => set({plan}),
  addMattes: (mattes) => set((s) => ({mattes: [...s.mattes, ...mattes]})),

  // snapshot the full editable state before a logical edit
  pushHistory: () => set((s) => ({past: [...s.past, snap(s)].slice(-HISTORY_LIMIT), future: []})),

  undo: () =>
    set((s) => {
      if (!s.past.length) return s;
      const prev = s.past[s.past.length - 1];
      return {...prev, meta: withMeta(s.meta, prev.clips), past: s.past.slice(0, -1), future: [snap(s), ...s.future], selectedId: null, selectedClipId: null};
    }),

  redo: () =>
    set((s) => {
      if (!s.future.length) return s;
      const next = s.future[0];
      return {...next, meta: withMeta(s.meta, next.clips), past: [...s.past, snap(s)], future: s.future.slice(1), selectedId: null, selectedClipId: null};
    }),
}));
