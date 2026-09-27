// Multi-clip timeline model. A project is an ordered list of clips, each with
// in/out trim points, assembled back-to-back. Optional music track on top.
// This is the spine of the editor: trim = change in/out, reorder = change order,
// delete = drop a clip. Captions are mapped onto the assembled timeline (see remapCaptions).
import {autoSources, lutBakes, type GradeParams, type ProjectGrade} from './grade.ts';
import type {Caption} from './captions.ts';
import type {BrollItem} from './brollModel.ts';
import type {Graphic} from './graphicTemplates.ts';

// a keyframe ("flag") pins a transform at a source-relative time inside the clip
export type Keyframe = {t: number; scale: number; x: number; y: number};

export type Clip = {
  id: string; // unique, stable per take (e.g. "IMG_0227")
  src: string; // staticFile-relative path, e.g. "clips/IMG_0227.mp4"
  label?: string; // human label shown on the track
  inSec: number; // trim: start offset inside the source
  outSec: number; // trim: end offset inside the source
  sourceDurationSec: number; // full length of the source (trim bounds)
  transform?: Keyframe[]; // keyframes (by source-time) for zoom/pan animation
  volume?: number; // clip audio gain, 1 = original
  muted?: boolean; // hard-mute the clip's own audio
  speed?: number; // playback rate (0.25..4), 1 = normal; timeline duration = source/speed
  enter?: import('./transitions.ts').Enter; // transition from the previous clip (src/transitions.ts)
  jSec?: number; // J-cut: the audio leads this many seconds under the previous clip's tail
  lSec?: number; // L-cut: the audio trails this many seconds under the next clip's head
  graded?: boolean; // the footage already carries the client's grade (true) or needs one (false); unset = not said
  location?: string; // where it was shot: color-jump never compares clips of two locations
  piece?: Piece; // which part of its variant (identity) the clip is: sync_family copies what sits on the body to the siblings
};
export const PIECES = ['hook', 'body', 'cta'] as const;
export type Piece = (typeof PIECES)[number];

// graded / location / piece as the user sets them (set_clip, the editor's Clip tab): null or '' clears one
export function clipTags(c: Clip, t: {graded?: boolean | null; location?: string | null; piece?: Piece | null}): Clip {
  const out = {...c};
  if (t.piece === null) delete out.piece;
  else if (t.piece !== undefined) out.piece = t.piece;
  if (t.graded === null) delete out.graded;
  else if (t.graded !== undefined) out.graded = t.graded;
  if (t.location !== undefined) {
    const l = (t.location ?? '').trim().slice(0, 60);
    if (l) out.location = l;
    else delete out.location;
  }
  return out;
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
const smooth = (f: number) => f * f * (3 - 2 * f); // smoothstep ease-in-out

// transform at a given source-time, interpolating between keyframes.
// 0 kf → identity · 1 kf → static · 2+ → eased interpolation, held past the ends.
export function sampleTransform(kfs: Keyframe[] | undefined, sourceSec: number): {scale: number; x: number; y: number} {
  if (!kfs || kfs.length === 0) return {scale: 1, x: 0, y: 0};
  const pick = (k: Keyframe) => ({scale: k.scale, x: k.x, y: k.y});
  if (kfs.length === 1 || sourceSec <= kfs[0].t) return pick(kfs[0]);
  const last = kfs[kfs.length - 1];
  if (sourceSec >= last.t) return pick(last);
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (sourceSec >= a.t && sourceSec <= b.t) {
      const f = b.t === a.t ? 0 : smooth((sourceSec - a.t) / (b.t - a.t));
      return {scale: lerp(a.scale, b.scale, f), x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f)};
    }
  }
  return pick(last);
}

export type Music = {
  src: string; // staticFile-relative, e.g. "music/track.mp3"
  volume: number; // 0..1
  startSec: number; // offset into the music file to begin from
  fadeInSec?: number; // fade at the start of the video (absent / 0 = none)
  fadeOutSec: number; // fade at the end of the video (0 = none)
  duck?: boolean; // auto-lower the music while someone is speaking
  duckLevel?: number; // ducked gain as a fraction of volume (default 0.25)
  credit?: string; // license credit line to ship with the reel (Openverse CC BY tracks, set_music)
} | null;

export type Project = {
  clips: Clip[];
  music: Music;
};

// TIMELINE duration (what the viewer experiences) — source span divided by speed
export const clipDurationSec = (c: Clip) => Math.max(0, (c.outSec - c.inSec) / (c.speed ?? 1));

// c picks up exactly where prev ends in the same source (a split with nothing cut out: a shot change of a
// pre-edit, a speed ramp's steps): to the speech it is one take, so words and caption pages run across the join
export const continuesPrev = (prev: Clip | undefined, c: Clip | undefined) =>
  !!prev && !!c && prev.src === c.src && Math.abs(c.inSec - prev.outSec) < 0.001;

// The edit shows no cut between prev and c: a plain cut (no transition in, or a punch carried on at the same scale —
// a split piece keeps its punch) into the same framing. The one rule of
// what reads as one uninterrupted picture — the render judge's shots (shotsOf) and the captions' takes (src/faces.ts)
// the scale a clip holds once in (a punch or a zoom lands at PUNCH_SCALE), and the one it starts at with no transition
// of its own (cut or a carried punch); null: a transition, never one shot with the clip before
export const PUNCH_SCALE = 1.12;
export const heldScale = (c?: Clip) => (c?.enter === 'punch' || c?.enter === 'zoom' ? PUNCH_SCALE : 1);
export const startScale = (c: Clip) => (!c.enter || c.enter === 'cut' ? 1 : c.enter === 'punch' ? PUNCH_SCALE : null);
export const plainJoin = (prev: Clip, c: Clip) => {
  const a = sampleTransform(prev.transform, prev.outSec), b = sampleTransform(c.transform, c.inSec);
  return startScale(c) === heldScale(prev) && Math.abs(a.scale - b.scale) + Math.abs(a.x - b.x) + Math.abs(a.y - b.y) < 1e-3;
};
// The edit's shots: clips joined where the source runs on (continuesPrev: a split that removed nothing — a pre-edit
// split at its own shot change, a half-graded head split off) with a plainJoin are one shot: the edit adds nothing on
// screen there (whatever the source shows there is the judge's source-cut). placed: placeClips → [{clip (its first),
// startMs, endMs, ids}]
export function shotsOf(placed: PlacedClip[]): {clip: Clip; startMs: number; endMs: number; ids: string[]}[] {
  const shots: {clip: Clip; startMs: number; endMs: number; ids: string[]}[] = [];
  placed.forEach((pc, k) => {
    const prev = placed[k - 1]?.clip;
    if (prev && continuesPrev(prev, pc.clip) && plainJoin(prev, pc.clip)) Object.assign(shots[shots.length - 1], {endMs: pc.endMs, ids: [...shots[shots.length - 1].ids, pc.clip.id]});
    else shots.push({clip: pc.clip, startMs: pc.startMs, endMs: pc.endMs, ids: [pc.clip.id]});
  });
  return shots;
}

// J/L-cuts (timeline seconds, clamped to what actually works):
// a J-cut plays the clip's first j seconds of audio under the previous clip's
// tail (the main clip mutes those first frames so the lead flows straight
// through the cut); it fits when the lead is no longer than the clip itself
// and no earlier than the previous clip's start. An L-cut keeps the audio
// going past the video cut, so it is bounded by the source left after outSec
// (and by the next clip's length, or the spill would outlive it).
export const jCutSec = (c: Clip, prevDurSec = Infinity) => Math.max(0, Math.min(c.jSec ?? 0, clipDurationSec(c), prevDurSec));
export const lCutSec = (c: Clip, nextDurSec = Infinity) =>
  Math.max(0, Math.min(c.lSec ?? 0, Math.max(0, c.sourceDurationSec - c.outSec) / (c.speed ?? 1), nextDurSec));

// Where each clip lands on the assembled timeline (in frames + ms), in order,
// with its J/L-cut audio in frames — decided here once, against the real
// neighbours, so the render, the mute in ClipMedia and the MCP report agree.
export type PlacedClip = {clip: Clip; fromFrame: number; durFrames: number; startMs: number; endMs: number; jFrames: number; lFrames: number};

export const placeClips = (clips: Clip[], fps: number): PlacedClip[] => {
  const durs = clips.map((c) => Math.max(1, Math.round(clipDurationSec(c) * fps)));
  let acc = 0;
  return clips.map((clip, i) => {
    const durFrames = durs[i];
    const fromFrame = acc;
    acc += durFrames;
    return {
      clip,
      fromFrame,
      durFrames,
      startMs: (fromFrame / fps) * 1000,
      endMs: ((fromFrame + durFrames) / fps) * 1000,
      jFrames: i > 0 ? Math.round(jCutSec(clip, durs[i - 1] / fps) * fps) : 0,
      lFrames: i < clips.length - 1 ? Math.round(lCutSec(clip, durs[i + 1] / fps) * fps) : 0,
    };
  });
};

// absolute timeline second → the clip under it and the source time inside it
// (the last clip when past the end). Shared by the MCP tools and the editor.
export function locateSec(clips: Clip[], fps: number, atSec: number): {clip: Clip; sourceSec: number; pc: PlacedClip} | null {
  const placed = placeClips(clips, fps);
  const ms = atSec * 1000;
  const pc = placed.find((x) => ms >= x.startMs && ms < x.endMs) ?? placed.at(-1);
  if (!pc) return null;
  const sourceSec = pc.clip.inSec + ((ms - pc.startMs) / 1000) * (pc.clip.speed ?? 1);
  return {clip: pc.clip, sourceSec: Math.min(pc.clip.outSec, Math.max(pc.clip.inSec, sourceSec)), pc};
}

export const totalDurationFrames = (clips: Clip[], fps: number): number =>
  Math.max(1, clips.reduce((sum, c) => sum + Math.max(1, Math.round(clipDurationSec(c) * fps)), 0));

// The frame rate a project renders at: a client's deliverables (a project with an identity,
// src/validate.ts) go out at 29.97 (NTSC, 30000/1001), everything else at 30 as always. Always a
// Number (ffmpeg reads String(30000/1001) = '29.97002997002997' as 30000/1001; the string
// '30000/1001' in `settb=1/${fps}` would make a wrong timebase). renderFps reads it back from render
// props (Root.tsx, the render runner): only these two values, whatever else the props say.
export const DELIVERY_FPS = 30000 / 1001;
export const deliveryFps = (p?: {identity?: {client?: string} | null} | null): number => (p?.identity?.client ? DELIVERY_FPS : 30);
export const renderFps = (props?: {fps?: unknown} | null): number => (props?.fps === DELIVERY_FPS ? DELIVERY_FPS : 30);
// how long the render lasts at that rate (each clip whole frames): what QC expects (POST /api/render, the CLI)
export const renderSec = (clips: Clip[], fps: number): number => totalDurationFrames(clips, fps) / fps;

// ---- edits shared by the editor store and the MCP server ----

// id for a new page / cue / graphic (k-th of a batch): one past the highest number in use, never a
// gap left by a deleted one — an id the agent still holds must not come back naming another item
export const nextId = (items: {id: string}[], prefix: string, k = 0) => `${prefix}${items.reduce((m, x) => Math.max(m, +(x.id.match(/(\d+)$/)?.[1] ?? -1) + 1), 0) + k}`;

// orig clip → the segments it became, for re-anchoring clip-bound items (B-roll)
export type SegmentRemap = {origId: string; segId: string; inMs: number; outMs: number}[];

// move clip-anchored items onto the segment that contains them (or the nearest)
export function reanchor<T extends {clipId?: string; startMs: number}>(items: T[], remap: SegmentRemap): T[] {
  return items.map((it) => {
    if (!it.clipId) return it;
    const segs = remap.filter((r) => r.origId === it.clipId);
    if (!segs.length) return it;
    const inside = segs.find((r) => it.startMs >= r.inMs && it.startMs < r.outMs);
    const target = inside ?? segs.reduce((best, r) => (Math.abs(r.inMs - it.startMs) < Math.abs(best.inMs - it.startMs) ? r : best), segs[0]);
    return {...it, clipId: target.segId};
  });
}

// The shortest piece a split leaves on screen: 3 frames at the reel's rate (29.97 or 30: 0.1001 / 0.1 s — the
// half-graded scan's shortest side), less the 2 ms of the millisecond source times validate prints. The two pieces
// continue each other in the source (continuesPrev): one shot on screen, nothing that flashes (the judge's shotsOf
// joins them). A trim or a cut (trimClip, cutRange) leaves a real cut behind and keeps its 0.2 s.
export const MIN_PIECE_SEC = 3 / DELIVERY_FPS - 0.002;
// a shot shorter than this is a flash (the render judge's flash-cut, T.flashMs): a word cut never leaves one behind
export const FLASH_SEC = 0.5;
// Split a clip at a source-time into two clips back-to-back; keyframes are
// pinned at the cut so the animation stays continuous. null = a piece under MIN_PIECE_SEC on the timeline.
// The one rule behind the editor's split, split_clip and every split made for it (cuts, ramps, sync_family).
export function splitClip(clips: Clip[], clipId: string, splitSrc: number): {clips: Clip[]; newId: string; remap: SegmentRemap} | null {
  const clip = clips.find((c) => c.id === clipId);
  if (!clip || (splitSrc - clip.inSec) / (clip.speed ?? 1) < MIN_PIECE_SEC || (clip.outSec - splitSrc) / (clip.speed ?? 1) < MIN_PIECE_SEC) return null;
  const newId = uniqId(clips.map((c) => c.id), clip.id.replace(/(-s\d+)+$/, ''), 's');
  const kfs = clip.transform;
  let aK = kfs?.filter((k) => k.t < splitSrc);
  let bK = kfs?.filter((k) => k.t >= splitSrc);
  if (kfs?.length) {
    const pin = {t: splitSrc, ...sampleTransform(kfs, splitSrc)};
    if (!aK?.some((k) => Math.abs(k.t - splitSrc) < 0.06)) aK = [...(aK ?? []), pin];
    if (!bK?.some((k) => Math.abs(k.t - splitSrc) < 0.06)) bK = [{...pin}, ...(bK ?? [])];
  }
  // a new cut starts plain: the J-cut stays with the head, the L-cut with the tail — but the second piece holds the
  // first's scale (a punch, or where a zoom lands: punch), or the split would pop the picture there
  const a = {...clip, outSec: splitSrc, transform: aK, lSec: undefined};
  const b = {...clip, id: newId, inSec: splitSrc, transform: bK, enter: clip.enter === 'punch' || clip.enter === 'zoom' ? 'punch' as const : undefined, jSec: undefined};
  const remap: SegmentRemap = [
    {origId: clip.id, segId: clip.id, inMs: clip.inSec * 1000, outMs: splitSrc * 1000},
    {origId: clip.id, segId: newId, inMs: splitSrc * 1000, outMs: clip.outSec * 1000},
  ];
  return {clips: clips.flatMap((c) => (c.id === clip.id ? [a, b] : [c])), newId, remap};
}

// set_speed_ramp and the editor's ramp: the clip split into speeds.length equal source pieces, each at its speed. Split
// at speed 1 (splitClip measures on the timeline): an already fast clip ramps like a slow one. null = a piece too short
export function rampClip(clips: Clip[], clipId: string, speeds: number[]): {clips: Clip[]; remap: SegmentRemap; ids: string[]} | null {
  const c = clips.find((x) => x.id === clipId);
  if (!c) return null;
  const span = c.outSec - c.inSec, ids = [clipId];
  let out = clips.map((x) => (x.id === clipId ? {...x, speed: 1} : x));
  for (let k = 1; k < speeds.length; k++) {
    const r = splitClip(out, ids.at(-1)!, c.inSec + (span * k) / speeds.length);
    if (!r) return null;
    out = r.clips; ids.push(r.newId);
  }
  out = out.map((x) => (ids.includes(x.id) ? {...x, speed: speeds[ids.indexOf(x.id)]} : x));
  return {clips: out, ids, remap: out.filter((x) => ids.includes(x.id)).map((x) => ({origId: clipId, segId: x.id, inMs: x.inSec * 1000, outMs: x.outSec * 1000}))};
}

// Trim a clip to [inSec, outSec] inside its source (an omitted end stays put),
// clamped to the source; a result under MIN_TRIM_SEC is refused, never stretched (a trim leaves a real cut — a split
// piece may be shorter, MIN_PIECE_SEC). The one rule behind the editor's trim handles and the trim_clip tool.
export const MIN_TRIM_SEC = 0.2;
// the editor's trim handle: a drag of d source seconds on one edge, clamped so the clip never inverts, never leaves its
// source and never moves the wrong way — a piece already under MIN_TRIM_SEC (a 3-frame split) does not shrink, and
// never grows into the footage beside it
export const trimDragSec = (c: {inSec: number; outSec: number; sourceDurationSec: number}, side: 'left' | 'right', d: number) =>
  side === 'left' ? Math.max(-c.inSec, Math.min(d, Math.max(0, c.outSec - MIN_TRIM_SEC - c.inSec)))
    : Math.max(Math.min(0, c.inSec + MIN_TRIM_SEC - c.outSec), Math.min(d, c.sourceDurationSec - c.outSec));
export function trimClip(clips: Clip[], clipId: string, inSec?: number, outSec?: number): {clips: Clip[]; clip: Clip} | {error: string} {
  const c = clips.find((x) => x.id === clipId);
  if (!c) return {error: `no clip ${clipId}`};
  const lo = Math.max(0, inSec ?? c.inSec);
  const hi = Math.min(c.sourceDurationSec, outSec ?? c.outSec);
  if (hi - lo < MIN_TRIM_SEC - 1e-9) return {error: `${clipId}: ${lo.toFixed(2)}–${hi.toFixed(2)}s would be shorter than ${MIN_TRIM_SEC} s (source is 0–${c.sourceDurationSec.toFixed(2)}s)`};
  const clip = {...c, inSec: lo, outSec: hi};
  return {clips: clips.map((x) => (x.id === clipId ? clip : x)), clip};
}

// short unique ids for pieces: base-s1, base-s2… (never base-s1-s3-s7 after repeated splits)
export function uniqId(taken: Iterable<string>, base: string, tag: string): string {
  const set = new Set(taken);
  let n = 1;
  while (set.has(`${base}-${tag}${n}`)) n++;
  return `${base}-${tag}${n}`;
}
// a clip added to the timeline (the editor, add_clips, reel clips add), or null: a source the project has already (the
// ingest hands an identical file back as that source, server/ingest.mjs) is not added twice — both copies' words would
// carry the same ids, and cut_words, key words and hidden words could not tell them apart (split_clip / trim_clip to
// use it twice). A new source whose id a clip has already gets the next free one.
export const addedClip = <C extends {id: string; src: string}>(clips: {id: string; src: string}[], clip: C): C | null =>
  clips.some((c) => c.src === clip.src) ? null : clips.some((c) => c.id === clip.id) ? {...clip, id: uniqId(clips.map((c) => c.id), clip.id, 'c')} : clip;

// Remove a source range [aSec, bSec] from a clip: a trim when it touches an
// edge (pieces under 0.2 s — or 3 frames on screen at a fast speed — fold into the cut), otherwise split where the kept
// tail starts and trim the head back to where the cut starts (the removed middle has no minimum). Callers snap the range
// into pauses (see cut_words).
export function cutRange(clips: Clip[], clipId: string, aSec: number, bSec: number): {clips: Clip[]; remap: SegmentRemap; removed: string[]} | null {
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) return null;
  const EDGE = Math.max(0.2, MIN_PIECE_SEC * (clip.speed ?? 1)); // source seconds: what is left must be a piece splitClip accepts
  let a = Math.max(clip.inSec, aSec);
  let b = Math.min(clip.outSec, bSec);
  if (b <= a) return null;
  if (a - clip.inSec < EDGE) a = clip.inSec;
  if (clip.outSec - b < EDGE) b = clip.outSec;
  if (a === clip.inSec && b === clip.outSec) return {clips: clips.filter((c) => c.id !== clipId), remap: [], removed: [clipId]};
  const seg = (c: Clip) => ({origId: clipId, segId: c.id, inMs: c.inSec * 1000, outMs: c.outSec * 1000});
  if (a === clip.inSec || b === clip.outSec) {
    const t = a === clip.inSec ? {...clip, inSec: b} : {...clip, outSec: a};
    return {clips: clips.map((c) => (c.id === clipId ? t : c)), remap: [seg(t)], removed: []};
  }
  const split = splitClip(clips, clipId, b);
  if (!split) return null;
  const pin = (k: Keyframe[] | undefined) => (k?.length ? [...k.filter((x) => x.t < a - 0.06), {t: a, ...sampleTransform(clip.transform!, a)}] : k); // the head's keyframes end at its new out
  const kept = split.clips.map((c) => (c.id === clipId ? {...c, outSec: a, transform: pin(c.transform)} : c));
  return {clips: kept, remap: kept.filter((c) => c.id === clipId || c.id === split.newId).map(seg), removed: []};
}

// Autocut: replace clips with their speech segments (ends + internal pauses removed);
// an empty segment list drops the clip (a piece of a take with no speech left).
export type AutocutPlan = {id: string; segments: {inSec: number; outSec: number}[]}[];
export function applyAutocut(clips: Clip[], plan: AutocutPlan): {clips: Clip[]; remap: SegmentRemap} {
  const byId = new Map(plan.map((p) => [p.id, p.segments]));
  const out: Clip[] = [];
  const remap: SegmentRemap = [];
  // ids must stay unique across REPEATED autocuts (re-segmenting "X" must not
  // mint another "X-c1" when one already exists)
  const taken = new Set(clips.map((c) => c.id));
  const uniq = (base: string) => {
    let id = base;
    let n = 1;
    while (taken.has(id)) id = `${base}-c${n++}`;
    taken.add(id);
    return id;
  };
  for (const c of clips) {
    const segs = byId.get(c.id);
    if (!segs) { out.push(c); continue; }
    if (!segs.length) continue;
    segs.forEach((seg, k) => {
      const id = k === 0 ? c.id : uniq(`${c.id}-c${k}`);
      // the J-cut stays with the first piece, the L-cut with the last; the seams between pieces start plain
      out.push({...c, id, inSec: seg.inSec, outSec: seg.outSec, ...(k ? {enter: undefined, jSec: undefined} : {}), ...(k < segs.length - 1 ? {lSec: undefined} : {})});
      remap.push({origId: c.id, segId: id, inMs: seg.inSec * 1000, outMs: seg.outSec * 1000});
    });
  }
  return {clips: out, remap};
}

// ---- variants of one script (CEO-5, D17): the body a family shares ----

type Variant = {hook?: number; cta?: number; v?: number} | null | undefined;
// The pieces of a variant's clips where its identity tells them: a hook variant opens with its hook — the clips of the
// first clip's source up to one of another source (G2's hook is two pieces of one file) — a CTA variant closes with its
// CTA the same way, and the rest is the body. A piece the user set stays; nothing is inferred for a plain variant ({v}
// or none) or when no body would be left. duplicate_project (and the editor's Duplicate) stores them on the copy.
export function inferPieces<C extends {src: string; piece?: Piece}>(clips: C[], variant: Variant): C[] {
  if (!variant || clips.every((c) => c.piece)) return clips;
  const run = (l: C[]) => { let n = 0; while (n < l.length && l[n].src === l[0].src) n++; return n; };
  const h = variant.hook ? run(clips) : 0, t = variant.cta ? run([...clips].reverse()) : 0;
  if ((!h && !t) || h + t >= clips.length) return clips;
  return clips.map((c, i) => (c.piece ? c : {...c, piece: i < h ? 'hook' : i >= clips.length - t ? 'cta' : 'body'}));
}

type Family = {
  clips: Clip[]; captions?: Caption[]; brolls?: BrollItem[]; graphics?: Graphic[]; mattes?: {src: string; startMs: number; endMs: number; file: string}[];
  grade?: ProjectGrade | null; hiddenWids?: string[]; identity?: {client?: string; family?: string; variant?: Variant} | null;
};
// the per-clip settings that go with the footage: playback, clip audio, what the footage is (J/L below: the head's, the tail's)
const OWN = ['speed', 'volume', 'muted', 'graded', 'location'] as const;
// sync_family (the MCP) and the editor's Sync body button: what `from` has on its body copied onto `sibling`, a variant
// of the same family and client. Body clips are matched by source + overlapping source range, never by clip id (the
// sibling may be cut apart). A sibling body clip takes the per-clip settings and clip grade override of the body clip
// it shows most — split where the from's differ (a speed ramp, a head graded apart); J/L live on joins: at the
// sibling's own hook / CTA seams they stay its own, between two of its body clips they are the from's where it has
// that join (the first piece showing a from clip takes its J, the last its L), else none. A source override goes along
// when the sibling shows only its body from that source. R = the source ranges both bodies show; what lies on R is the
// from's, by span (never by where an item starts: two bodies trimmed apart cut pages and graphics): the sibling's
// captions, graphics, B-roll cues (on a body clip) there go — a page across R's edge keeps its words outside — and the
// from's come in, each on R only (a page with its words there, a cue on the first sibling body clip under it); an
// item of each alike but for its id is left as the sibling has it. Hidden words (deleted pages) swap only on R: a
// word's time from `words` (the sibling's, src/validate.ts projectWords) or a page. All of it is source time: each
// lands on the sibling's own timeline (its hook may be longer). Hook and CTA are never touched. A copied graphic whose
// figure or name the sibling's audio does not say (unbacked: unbackedData over its words) stays behind, and the
// sibling's own there stays. → the sibling, what was done, and what of its own it lost (`replaced`), or why not.
// ponytail: B-roll cues with no clip (timeline-absolute, legacy) stay as they are
export function syncFamily<P extends Family>(from: P, sibling: P, {words = [], unbacked}: {words?: {source: string; words: {i: number; startMs: number}[]}[]; unbacked?: (p: P) => {ref: string; dato?: string}[]} = {}): {project: P; said: string; replaced: string[]} | {error: string} {
  const a = from.identity, b = sibling.identity;
  if (!a?.client || !a.family || a.client !== b?.client || a.family !== b?.family) return {error: `not the same family and client (${a?.family ?? 'no identity'} of ${a?.client ?? '—'} vs ${b?.family ?? 'no identity'} of ${b?.client ?? '—'}) — sync_family never crosses them`};
  const bodyIds = (p: Family) => new Set(inferPieces(p.clips, p.identity?.variant).filter((c) => c.piece === 'body').map((c) => c.id));
  const fbIds = bodyIds(from), fb = from.clips.filter((c) => fbIds.has(c.id));
  if (!fb.length) return {error: 'the from project has no body clip (set_clip piece: body)'};
  const sb = bodyIds(sibling);
  const over = (c: Clip, f: Clip) => Math.min(c.outSec, f.outSec) - Math.max(c.inSec, f.inSec);
  const shown = (c: Clip) => fb.filter((f) => f.src === c.src && over(c, f) > 0).sort((x, y) => x.inSec - y.inSec);
  if (![...sb].some((id) => shown(sibling.clips.find((c) => c.id === id)!).length)) return {error: `no body clip of it shows the from's body (${[...new Set(fb.map((f) => f.src))].join(', ')}) — set_clip piece: body on its body clips`};
  const fo = from.grade?.overrides ?? {}, so = sibling.grade?.overrides ?? {};
  const look = (f: Clip) => JSON.stringify([...OWN.map((k) => f[k] ?? null), fo[f.id] ?? null]);
  let clips = sibling.clips, brolls = sibling.brolls ?? [], splits = 0;
  const origin = new Map<string, string>(); // a piece split off here → the sibling clip it was
  for (const id of [...sb]) {
    const fs = shown(clips.find((c) => c.id === id)!);
    let cur = id;
    for (let k = 1; k < fs.length; k++) {
      if (look(fs[k]) === look(fs[k - 1])) continue;
      const r = splitClip(clips, cur, fs[k].inSec); // refused under MIN_PIECE_SEC from an edge: that piece follows the clip it shows most
      if (!r) continue;
      clips = r.clips; brolls = reanchor(brolls, r.remap); sb.add(r.newId); origin.set(r.newId, id); cur = r.newId; splits++;
    }
  }
  const ov: Record<string, GradeParams> = {...so};
  const set = <T extends object>(o: T, k: keyof T, v: unknown) => { if (v === undefined) delete o[k]; else o[k] = v as T[keyof T]; };
  const body = (c?: Clip) => !!c && sb.has(c.id);
  const fromJoin = (f: Clip, d: number) => fbIds.has(from.clips[from.clips.indexOf(f) + d]?.id ?? ''); // the from's neighbour is body too
  const onF = (l: Clip[], f: Clip) => l.some((k) => body(k) && k.src === f.src && over(k, f) > 0);
  const before = clips;
  clips = before.map((c, i) => {
    const fs = body(c) ? shown(c) : [];
    if (!fs.length) return c;
    const best = fs.reduce((x, y) => (over(c, y) > over(c, x) ? y : x)), out = {...c}, f0 = fs[0], f1 = fs[fs.length - 1];
    for (const k of OWN) set(out, k, best[k]);
    if (body(before[i - 1])) set(out, 'jSec', !onF(before.slice(0, i), f0) && fromJoin(f0, -1) ? f0.jSec : undefined);
    if (body(before[i + 1])) set(out, 'lSec', !onF(before.slice(i + 1), f1) && fromJoin(f1, 1) ? f1.lSec : undefined);
    set(ov, c.id, fo[best.id]);
    return out;
  });
  const replaced: string[] = []; // what of the sibling's own, set apart from the from's, the sync takes away
  for (const o of sibling.clips) {
    const ps = clips.filter((c) => (origin.get(c.id) ?? c.id) === o.id);
    if (!ps.some((c) => body(c) && shown(c).length)) continue;
    const lost = [...OWN.filter((k) => o[k] !== undefined && ps.some((c) => c[k] !== o[k])), ...(o.jSec !== undefined && ps[0].jSec !== o.jSec ? ['jSec'] : []),
      ...(o.lSec !== undefined && ps[ps.length - 1].lSec !== o.lSec ? ['lSec'] : []), ...(so[o.id] && ps.some((c) => JSON.stringify(ov[c.id]) !== JSON.stringify(so[o.id])) ? ['grade override'] : [])];
    if (lost.length) replaced.push(`${o.id}'s ${lost.join(' ')}`);
  }
  const notes: string[] = [];
  for (const src of new Set(fb.map((f) => f.src))) {
    if (!clips.some((c) => c.src === src && sb.has(c.id)) || JSON.stringify(fo[src]) === JSON.stringify(ov[src])) continue;
    if (clips.some((c) => c.src === src && !sb.has(c.id))) notes.push(`the grade of ${src} stays: the sibling's hook or CTA is from it too`);
    else { if (so[src]) replaced.push(`grade override of ${src}`); set(ov, src, fo[src]); }
  }
  const R = fb.flatMap((f) => clips.filter((c) => sb.has(c.id) && c.src === f.src && over(c, f) > 0).map((c) => ({src: f.src, a: Math.max(f.inSec, c.inSec) * 1000, b: Math.min(f.outSec, c.outSec) * 1000})));
  const inR = (src: string, ms: number) => R.some((r) => r.src === src && ms >= r.a && ms < r.b);
  const hits = (src: string, a: number, b: number) => R.some((r) => r.src === src && a < r.b && r.a < b);
  const mattes = [...(sibling.mattes ?? []), ...(from.mattes ?? []).filter((m) => hits(m.src, m.startMs, m.endMs) && !sibling.mattes?.some((x) => x.file === m.file))];
  let grade = sibling.grade ?? null;
  if (JSON.stringify(ov) !== JSON.stringify(grade?.overrides ?? {})) {
    const g: ProjectGrade = {...(grade ?? {look: 'none', intensity: 0.8, auto: false, bySrc: {}}), overrides: ov};
    const bakes = lutBakes(g, clips, mattes).filter((x) => !g.baked?.[x.key] && from.grade?.baked?.[x.key]); // the copies the from has baked already
    if (bakes.length) g.baked = {...g.baked, ...Object.fromEntries(bakes.map((x) => [x.key, from.grade!.baked![x.key]]))};
    const auto = autoSources(g, clips).filter((s) => !g.bySrc?.[s] && from.grade?.bySrc?.[s]);
    if (auto.length) g.bySrc = {...g.bySrc, ...Object.fromEntries(auto.map((s) => [s, from.grade!.bySrc[s]]))};
    grade = g;
  }
  // the sibling's items on R and the from's as they would land: a pair alike but for the id stays the sibling's
  const bare = (x: object) => JSON.stringify({...x, id: undefined});
  const pair = <T extends {id: string}>(mine: T[], theirs: T[]) => {
    const add = [...theirs], gone: T[] = [];
    for (const x of mine) { const j = add.findIndex((y) => bare(y) === bare(x)); if (j < 0) gone.push(x); else add.splice(j, 1); }
    return {gone, add};
  };
  // each added item keeps its id unless an item the sibling keeps has it
  const swap = <T extends {id: string}>(kept: T[], add: T[], prefix: string) => {
    const taken: {id: string}[] = [...kept];
    const added = add.map((x) => { const y = {...x, id: taken.some((t) => t.id === x.id) ? nextId(taken, prefix) : x.id}; taken.push(y); return y; });
    return {all: [...kept, ...added], added};
  };
  const at = new Map<string, number>(); // a word id → its source ms
  for (const t of words) for (const w of t.words) at.set(`${t.source}:${w.i}`, w.startMs);
  for (const c of [...(sibling.captions ?? []), ...(from.captions ?? [])]) for (const w of c.words) if (w.wid && !at.has(w.wid)) at.set(w.wid, w.startMs);
  const widInR = (w: string) => { const t = at.get(w); return t != null && R.some((r) => r.src.split('/').pop()!.replace(/\.[^.]+$/, '') === w.slice(0, w.lastIndexOf(':')) && t >= r.a && t < r.b); };
  // a page's words on R (on = true) or off it; the page itself when all of them are
  const part = (c: Caption, on: boolean): Caption | null => {
    const keep = (ms: number) => inR(c.src, ms) === on, ws = c.words.filter((w) => keep(w.startMs)), last = ws[ws.length - 1];
    if (ws.length === c.words.length) return ws.length || keep(c.startMs) ? c : null;
    if (!ws.length) return null;
    return {...c, words: ws, startMs: ws[0] === c.words[0] ? c.startMs : ws[0].startMs, endMs: last === c.words[c.words.length - 1] ? c.endMs : last.endMs, ...(c.covers ? {covers: c.covers.filter((w) => !at.has(w) || widInR(w) === on)} : {})};
  };
  const sOn = new Map((sibling.captions ?? []).flatMap((c) => { const r = part(c, true); return r ? [[r, c] as const] : []; }));
  const cp = pair([...sOn.keys()], (from.captions ?? []).flatMap((c) => part(c, true) ?? []));
  const goneCaps = new Set(cp.gone.map((r) => sOn.get(r)!));
  const caps = swap((sibling.captions ?? []).flatMap((c) => (goneCaps.has(c) ? part(c, false) ?? [] : [c])), cp.add, 'c');
  const gOn = (g: Graphic) => hits(g.src, g.startMs, g.endMs);
  const gp = pair((sibling.graphics ?? []).filter(gOn), (from.graphics ?? []).filter(gOn));
  const gfx = swap((sibling.graphics ?? []).filter((g) => !gp.gone.includes(g)), gp.add, 'g');
  const landed = (x: BrollItem): BrollItem[] => {
    const f = fb.find((k) => k.id === x.clipId);
    if (!f || !hits(f.src, x.startMs, x.endMs)) return [];
    const span = (k: Clip) => Math.min(x.endMs, k.outSec * 1000) - Math.max(x.startMs, k.inSec * 1000);
    const c = clips.find((k) => body(k) && k.src === f.src && span(k) > 0); // the first under it; never before its clip (into the hook)
    return c ? [{...x, clipId: c.id, startMs: Math.max(x.startMs, c.inSec * 1000)}] : [];
  };
  const bp = pair(brolls.filter((x) => { const c = clips.find((k) => k.id === x.clipId); return body(c) && hits(c!.src, x.startMs, x.endMs); }), (from.brolls ?? []).flatMap(landed));
  const cues = swap(brolls.filter((x) => !bp.gone.includes(x)), bp.add, 'b');
  const hiddenWids = [...new Set([...(sibling.hiddenWids ?? []).filter((w) => !widInR(w)), ...(from.hiddenWids ?? []).filter(widInR)])];
  let project = {...sibling, clips, captions: caps.all, graphics: gfx.all, brolls: cues.all, mattes, grade, hiddenWids};
  const bad = new Map((unbacked?.(project) ?? []).filter((d) => gfx.added.some((g) => g.id === d.ref)).map((d) => [d.ref, d.dato]));
  // a graphic left out leaves the sibling's own it would have replaced, unless a graphic of the from kept covers it too
  const near = (x: Graphic, y: Graphic) => x.src === y.src && x.startMs < y.endMs && y.startMs < x.endMs;
  const stays = gp.gone.filter((g) => gfx.added.some((x) => bad.has(x.id) && near(g, x)) && !gfx.added.some((x) => !bad.has(x.id) && near(g, x)));
  if (bad.size) {
    const kept = project.graphics.filter((g) => !bad.has(g.id));
    for (const g of stays) kept.push(kept.some((k) => k.id === g.id) ? {...g, id: nextId(kept, 'g')} : g);
    project = {...project, graphics: kept};
  }
  replaced.push(...[...goneCaps].map((c) => `caption page ${c.id}`), ...gp.gone.filter((g) => !stays.includes(g)).map((g) => `graphic ${g.id}`), ...bp.gone.map((x) => `B-roll cue ${x.id}`));
  const n = (k: number, what: string) => `${k} ${what}${k === 1 ? '' : 's'}`;
  const said = [`${n(sb.size, 'body clip')}${splits ? ` (${n(splits, 'split')} to follow the from's)` : ''}`, n(caps.added.length, 'caption page'), n(gfx.added.length - bad.size, 'graphic'), n(cues.added.length, 'B-roll cue'),
    ...(grade !== (sibling.grade ?? null) ? ['grade overrides'] : []), ...[...bad].map(([g, d]) => `${g} left out ("${d}": dato sin respaldo en el audio de este reel)`),
    ...(stays.length ? [`its own ${stays.map((g) => g.id).join(', ')} kept there`] : []), ...notes, ...(replaced.length ? [`replaced ${replaced.length} of its own: ${replaced.join('; ')}`] : [])].join(', ');
  return {project, said, replaced};
}
