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

// Split a clip at a source-time into two clips back-to-back; keyframes are
// pinned at the cut so the animation stays continuous. null = too close to an edge.
export function splitClip(clips: Clip[], clipId: string, splitSrc: number): {clips: Clip[]; newId: string; remap: SegmentRemap} | null {
  const clip = clips.find((c) => c.id === clipId);
  if (!clip || splitSrc - clip.inSec < 0.2 || clip.outSec - splitSrc < 0.2) return null;
  const newId = uniqId(clips.map((c) => c.id), clip.id.replace(/(-s\d+)+$/, ''), 's');
  const kfs = clip.transform;
  let aK = kfs?.filter((k) => k.t < splitSrc);
  let bK = kfs?.filter((k) => k.t >= splitSrc);
  if (kfs?.length) {
    const pin = {t: splitSrc, ...sampleTransform(kfs, splitSrc)};
    if (!aK?.some((k) => Math.abs(k.t - splitSrc) < 0.06)) aK = [...(aK ?? []), pin];
    if (!bK?.some((k) => Math.abs(k.t - splitSrc) < 0.06)) bK = [{...pin}, ...(bK ?? [])];
  }
  // a new cut starts plain: the J-cut stays with the head, the L-cut with the tail
  const a = {...clip, outSec: splitSrc, transform: aK, lSec: undefined};
  const b = {...clip, id: newId, inSec: splitSrc, transform: bK, enter: undefined, jSec: undefined};
  const remap: SegmentRemap = [
    {origId: clip.id, segId: clip.id, inMs: clip.inSec * 1000, outMs: splitSrc * 1000},
    {origId: clip.id, segId: newId, inMs: splitSrc * 1000, outMs: clip.outSec * 1000},
  ];
  return {clips: clips.flatMap((c) => (c.id === clip.id ? [a, b] : [c])), newId, remap};
}

// Trim a clip to [inSec, outSec] inside its source (an omitted end stays put),
// clamped to the source; a result under 0.2 s is refused, never stretched.
// The one rule behind the editor's trim handles and the trim_clip tool.
export function trimClip(clips: Clip[], clipId: string, inSec?: number, outSec?: number): {clips: Clip[]; clip: Clip} | {error: string} {
  const c = clips.find((x) => x.id === clipId);
  if (!c) return {error: `no clip ${clipId}`};
  const lo = Math.max(0, inSec ?? c.inSec);
  const hi = Math.min(c.sourceDurationSec, outSec ?? c.outSec);
  if (hi - lo < 0.2 - 1e-9) return {error: `${clipId}: ${lo.toFixed(2)}–${hi.toFixed(2)}s would be shorter than 0.2 s (source is 0–${c.sourceDurationSec.toFixed(2)}s)`};
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
// edge (pieces under 0.2 s fold into the cut), otherwise split twice and drop
// the middle. Callers snap the range into pauses (see cut_words).
export function cutRange(clips: Clip[], clipId: string, aSec: number, bSec: number): {clips: Clip[]; remap: SegmentRemap; removed: string[]} | null {
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) return null;
  const EDGE = 0.2;
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
  const first = splitClip(clips, clipId, a);
  if (!first) return null;
  const second = splitClip(first.clips, first.newId, b);
  if (!second) return null;
  const kept = second.clips.filter((c) => c.id !== first.newId);
  return {clips: kept, remap: kept.filter((c) => c.id === clipId || c.id === second.newId).map(seg), removed: [first.newId]};
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
// sibling may be cut apart). A sibling body clip takes the per-clip settings, J/L and clip grade override of the body
// clip it shows most — split where the from's differ (a speed ramp, a head graded apart); a source override goes along
// when the sibling shows only its body from that source. Captions, graphics (source-anchored), B-roll cues (on a body
// clip) and mattes inside the source range both bodies show replace the sibling's there; words hidden with a deleted
// page go along for a source only the body uses. All of it is source time: each lands on the sibling's own timeline
// (its hook may be longer). Hook and CTA are never touched. A copied graphic whose figure or name the sibling's audio
// does not say (unbacked: src/validate.ts unbackedData over its words) stays behind. → the sibling, or why not.
// ponytail: B-roll cues with no clip (timeline-absolute, legacy) stay as they are; items are placed by where they start
export function syncFamily<P extends Family>(from: P, sibling: P, {unbacked}: {unbacked?: (p: P) => {ref: string; dato?: string}[]} = {}): {project: P; said: string} | {error: string} {
  const a = from.identity, b = sibling.identity;
  if (!a?.client || !a.family || a.client !== b?.client || a.family !== b?.family) return {error: `not the same family and client (${a?.family ?? 'no identity'} of ${a?.client ?? '—'} vs ${b?.family ?? 'no identity'} of ${b?.client ?? '—'}) — sync_family never crosses them`};
  const bodyIds = (p: Family) => new Set(inferPieces(p.clips, p.identity?.variant).filter((c) => c.piece === 'body').map((c) => c.id));
  const fbIds = bodyIds(from), fb = from.clips.filter((c) => fbIds.has(c.id));
  if (!fb.length) return {error: 'the from project has no body clip (set_clip piece: body)'};
  const sb = bodyIds(sibling);
  const over = (c: Clip, f: Clip) => Math.min(c.outSec, f.outSec) - Math.max(c.inSec, f.inSec);
  const shown = (c: Clip) => fb.filter((f) => f.src === c.src && over(c, f) > 0).sort((x, y) => x.inSec - y.inSec);
  if (![...sb].some((id) => shown(sibling.clips.find((c) => c.id === id)!).length)) return {error: `no body clip of it shows the from's body (${[...new Set(fb.map((f) => f.src))].join(', ')}) — set_clip piece: body on its body clips`};
  const fo = from.grade?.overrides ?? {};
  const look = (f: Clip) => JSON.stringify([...OWN.map((k) => f[k] ?? null), fo[f.id] ?? null]);
  let clips = sibling.clips, brolls = sibling.brolls ?? [], splits = 0;
  for (const id of [...sb]) {
    const fs = shown(clips.find((c) => c.id === id)!);
    let cur = id;
    for (let k = 1; k < fs.length; k++) {
      if (look(fs[k]) === look(fs[k - 1])) continue;
      const r = splitClip(clips, cur, fs[k].inSec); // refused under 0.2 s from an edge: that piece follows the clip it shows most
      if (!r) continue;
      clips = r.clips; brolls = reanchor(brolls, r.remap); sb.add(r.newId); cur = r.newId; splits++;
    }
  }
  const ov: Record<string, GradeParams> = {...sibling.grade?.overrides};
  const set = <T extends object>(o: T, k: keyof T, v: unknown) => { if (v === undefined) delete o[k]; else o[k] = v as T[keyof T]; };
  clips = clips.map((c) => {
    const fs = sb.has(c.id) ? shown(c) : [];
    if (!fs.length) return c;
    const best = fs.reduce((x, y) => (over(c, y) > over(c, x) ? y : x)), out = {...c};
    for (const k of OWN) set(out, k, best[k]);
    set(out, 'jSec', fs[0].jSec); set(out, 'lSec', fs[fs.length - 1].lSec);
    set(ov, c.id, fo[best.id]);
    return out;
  });
  const notes: string[] = [];
  for (const src of new Set(fb.map((f) => f.src))) {
    if (!clips.some((c) => c.src === src && sb.has(c.id)) || JSON.stringify(fo[src]) === JSON.stringify(ov[src])) continue;
    if (clips.some((c) => c.src === src && !sb.has(c.id))) notes.push(`the grade of ${src} stays: the sibling's hook or CTA is from it too`);
    else set(ov, src, fo[src]);
  }
  // the source ranges both bodies show: what lies there is the from's
  const R = fb.flatMap((f) => clips.filter((c) => sb.has(c.id) && c.src === f.src && over(c, f) > 0).map((c) => ({src: f.src, a: Math.max(f.inSec, c.inSec) * 1000, b: Math.min(f.outSec, c.outSec) * 1000})));
  const inR = (src: string, ms: number) => R.some((r) => r.src === src && ms >= r.a && ms < r.b);
  const mattes = [...(sibling.mattes ?? []), ...(from.mattes ?? []).filter((m) => R.some((r) => r.src === m.src && m.startMs < r.b && r.a < m.endMs) && !sibling.mattes?.some((x) => x.file === m.file))];
  let grade = sibling.grade ?? null;
  if (JSON.stringify(ov) !== JSON.stringify(grade?.overrides ?? {})) {
    const g: ProjectGrade = {...(grade ?? {look: 'none', intensity: 0.8, auto: false, bySrc: {}}), overrides: ov};
    const bakes = lutBakes(g, clips, mattes).filter((x) => !g.baked?.[x.key] && from.grade?.baked?.[x.key]); // the copies the from has baked already
    if (bakes.length) g.baked = {...g.baked, ...Object.fromEntries(bakes.map((x) => [x.key, from.grade!.baked![x.key]]))};
    const auto = autoSources(g, clips).filter((s) => !g.bySrc?.[s] && from.grade?.bySrc?.[s]);
    if (auto.length) g.bySrc = {...g.bySrc, ...Object.fromEntries(auto.map((s) => [s, from.grade!.bySrc[s]]))};
    grade = g;
  }
  // the sibling's items there go, the from's come in: each keeps its id unless an item the sibling keeps has it
  const swap = <T extends {id: string}>(kept: T[], add: T[], prefix: string) => {
    const taken: {id: string}[] = [...kept];
    const added = add.map((x) => { const y = {...x, id: taken.some((t) => t.id === x.id) ? nextId(taken, prefix) : x.id}; taken.push(y); return y; });
    return {all: [...kept, ...added], added};
  };
  const capAt = (c: Caption) => inR(c.src, c.words[0]?.startMs ?? c.startMs), gfxAt = (g: Graphic) => inR(g.src, g.startMs);
  const caps = swap((sibling.captions ?? []).filter((c) => !capAt(c)), (from.captions ?? []).filter(capAt), 'c');
  const gfx = swap((sibling.graphics ?? []).filter((g) => !gfxAt(g)), (from.graphics ?? []).filter(gfxAt), 'g');
  const on = (x: BrollItem, c?: Clip) => !!c && inR(c.src, x.startMs);
  const cues = swap(brolls.filter((x) => !on(x, sb.has(x.clipId ?? '') ? clips.find((c) => c.id === x.clipId) : undefined)), (from.brolls ?? []).flatMap((x) => {
    const f = fb.find((k) => k.id === x.clipId), c = f && on(x, f) ? clips.find((k) => sb.has(k.id) && k.src === f.src && x.startMs >= k.inSec * 1000 && x.startMs < k.outSec * 1000) : undefined;
    return c ? [{...x, clipId: c.id}] : [];
  }), 'b');
  const only = new Set([...new Set(fb.map((f) => f.src))].filter((s) => from.clips.every((c) => c.src !== s || fb.includes(c)) && clips.every((c) => c.src !== s || sb.has(c.id))).map((s) => s.split('/').pop()!.replace(/\.[^.]+$/, '')));
  const mine = (w: string) => only.has(w.slice(0, w.lastIndexOf(':')));
  const hiddenWids = [...new Set([...(sibling.hiddenWids ?? []).filter((w) => !mine(w)), ...(from.hiddenWids ?? []).filter(mine)])];
  let project = {...sibling, clips, captions: caps.all, graphics: gfx.all, brolls: cues.all, mattes, grade, hiddenWids};
  const bad = new Map((unbacked?.(project) ?? []).filter((d) => gfx.added.some((g) => g.id === d.ref)).map((d) => [d.ref, d.dato]));
  if (bad.size) project = {...project, graphics: project.graphics.filter((g) => !bad.has(g.id))};
  const n = (k: number, what: string) => `${k} ${what}${k === 1 ? '' : 's'}`;
  const said = [`${n(sb.size, 'body clip')}${splits ? ` (${n(splits, 'split')} to follow the from's)` : ''}`, n(caps.added.length, 'caption page'), n(gfx.added.length - bad.size, 'graphic'), n(cues.added.length, 'B-roll cue'),
    ...(grade !== (sibling.grade ?? null) ? ['grade overrides'] : []), ...[...bad].map(([g, d]) => `${g} left out ("${d}": dato sin respaldo en el audio de este reel)`), ...notes].join(', ');
  return {project, said};
}
