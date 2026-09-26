// Multi-clip timeline model. A project is an ordered list of clips, each with
// in/out trim points, assembled back-to-back. Optional music track on top.
// This is the spine of the editor: trim = change in/out, reorder = change order,
// delete = drop a clip. Captions are mapped onto the assembled timeline (see remapCaptions).

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
};

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
