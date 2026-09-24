import {create} from 'zustand';
import type {Caption} from '../src/captions';
import type {BrollItem, BrollAsset} from '../src/Broll';
import {applyAutocut as autocutClips, placeClips, reanchor, splitClip, totalDurationFrames, type Clip, type Music} from '../src/timeline';

export type Meta = {durationInFrames: number; fps: number; width: number; height: number};
export type Lang = 'auto' | 'es' | 'en';

const HISTORY_LIMIT = 100;

// one undo step = the full editable state
type Snapshot = {clips: Clip[]; music: Music; captions: Caption[]; brolls: BrollItem[]};

type EditorState = {
  meta: Meta | null;
  projectId: string | null;
  projectName: string;
  captions: Caption[];
  clips: Clip[];
  music: Music;
  brolls: BrollItem[];
  brollAssets: BrollAsset[];
  accentColor: string;
  selectedId: string | null;
  selectedClipId: string | null;
  currentFrame: number;
  lang: Lang; // transcription language for this project

  // undo/redo: снапшоты ВСЕГО редактируемого состояния (clips/music/captions/brolls).
  // Толкаем ОДИН раз в начале логической правки — драг не флудит историю.
  past: Snapshot[];
  future: Snapshot[];

  init: (meta: Meta, captions: Caption[], accentColor?: string, clips?: Clip[], music?: Music, brolls?: BrollItem[], brollAssets?: BrollAsset[], lang?: Lang) => void;
  addBrollAsset: (asset: BrollAsset) => void;
  removeBrollAsset: (id: string) => void;
  select: (id: string | null) => void;
  setCurrentFrame: (f: number) => void;
  setTopPct: (id: string, topPct: number) => void;
  setCaptionScale: (id: string, scale: number) => void;
  setBrollScale: (id: string, scale: number) => void;
  setText: (id: string, text: string) => void;
  toggleAccent: (id: string, wordIndex: number) => void;

  // clips track (multi-clip timeline)
  addClip: (clip: Clip) => void;
  setClipOrder: (orderedIds: string[]) => void;
  splitClipAtFrame: (frame: number) => void;
  setKeyframe: (clipId: string, t: number, tr: {scale: number; x: number; y: number}) => void;
  removeKeyframe: (clipId: string, t: number) => void;
  applyAutocut: (plan: {id: string; segments: {inSec: number; outSec: number}[]}[]) => void;
  removeClips: (ids: string[]) => void;
  setLang: (lang: Lang) => void;
  selectClip: (id: string | null) => void;
  deleteClip: (id: string) => void;
  moveClip: (id: string, dir: -1 | 1) => void;
  moveClipTo: (id: string, index: number) => void;
  trimClip: (id: string, inSec: number, outSec: number) => void;
  setClipVolume: (id: string, volume: number) => void;
  toggleClipMute: (id: string) => void;
  setClipSpeed: (id: string, speed: number) => void;
  setMusic: (music: Music) => void;
  setAccentColor: (color: string) => void;
  setCaptions: (captions: Caption[]) => void;
  setProjectInfo: (id: string, name: string) => void;
  setProjectName: (name: string) => void;

  // b-roll
  setBrolls: (brolls: BrollItem[]) => void;
  removeBroll: (id: string) => void;
  setBrollMode: (id: string, mode: BrollItem['mode']) => void;
  swapBroll: (id: string) => void;

  pushHistory: () => void;
  undo: () => void;
  redo: () => void;
};

// recompute timeline length in frames from the current clips
const withMeta = (meta: Meta | null, clips: Clip[]): Meta | null =>
  meta ? {...meta, durationInFrames: totalDurationFrames(clips, meta.fps)} : meta;

// capture the undoable slice of state
type Snappable = {clips: Clip[]; music: Music; captions: Caption[]; brolls: BrollItem[]};
const snap = (s: Snappable): Snapshot => ({clips: s.clips, music: s.music, captions: s.captions, brolls: s.brolls});
// returns the {past, future} patch to prepend to a mutation that should be undoable
const withHistory = (s: Snappable & {past: Snapshot[]}) => ({
  past: [...s.past, snap(s)].slice(-HISTORY_LIMIT),
  future: [] as Snapshot[],
});

const mapCap = (caps: Caption[], id: string, fn: (c: Caption) => Caption) =>
  caps.map((c) => (c.id === id ? fn(c) : c));

export const useEditor = create<EditorState>((set) => ({
  meta: null,
  projectId: null,
  projectName: 'Untitled project',
  captions: [],
  clips: [],
  music: null,
  brolls: [],
  brollAssets: [],
  accentColor: '#FFB020',
  selectedId: null,
  selectedClipId: null,
  currentFrame: 0,
  lang: 'auto',
  past: [],
  future: [],

  init: (meta, captions, accentColor, clips = [], music = null, brolls = [], brollAssets = [], lang = 'auto') =>
    set((s) => ({
      meta: withMeta(meta, clips),
      projectId: null, // caller assigns via setProjectInfo — prevents autosaving a cleared state into the old project
      projectName: 'Untitled project',
      captions,
      clips,
      music,
      brolls,
      brollAssets,
      accentColor: accentColor ?? s.accentColor,
      lang,
      past: [],
      future: [],
    })),
  addBrollAsset: (asset) => set((s) => ({brollAssets: [...s.brollAssets, asset]})),
  removeBrollAsset: (id) => set((s) => ({brollAssets: s.brollAssets.filter((a) => a.id !== id)})),
  select: (id) => set({selectedId: id, selectedClipId: null}),
  setCurrentFrame: (f) => set({currentFrame: f}),

  setTopPct: (id, topPct) => set((s) => ({captions: mapCap(s.captions, id, (c) => ({...c, topPct}))})),
  setCaptionScale: (id, scale) => set((s) => ({captions: mapCap(s.captions, id, (c) => ({...c, scale}))})),
  setBrollScale: (id, scale) => set((s) => ({brolls: s.brolls.map((b) => (b.id === id ? {...b, scale} : b))})),

  // правка текста: ре-токенизация, равномерное распределение тайминга,
  // сохранение акцентов по совпадению слова
  setText: (id, text) =>
    set((s) => ({
      captions: mapCap(s.captions, id, (c) => {
        const tokens = text.trim().split(/\s+/).filter(Boolean);
        if (!tokens.length) return c;
        const accented = new Set(c.words.filter((w) => w.accent).map((w) => w.text.toLowerCase()));
        const per = (c.endMs - c.startMs) / tokens.length;
        const words = tokens.map((t, i) => ({
          text: t,
          startMs: Math.round(c.startMs + i * per),
          endMs: Math.round(c.startMs + (i + 1) * per),
          accent: accented.has(t.toLowerCase()),
        }));
        return {...c, words};
      }),
    })),

  toggleAccent: (id, wi) =>
    set((s) => ({
      captions: mapCap(s.captions, id, (c) => ({
        ...c,
        words: c.words.map((w, i) => (i === wi ? {...w, accent: !w.accent} : w)),
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

  // push history only on add/remove (not on every volume/fade slider tick)
  setMusic: (music) =>
    set((s) => {
      const structural = (s.music === null) !== (music === null);
      return {...(structural ? withHistory(s) : {}), music};
    }),
  setAccentColor: (accentColor) => set({accentColor}),
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
