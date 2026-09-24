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
} | null;

export type Project = {
  clips: Clip[];
  music: Music;
};

// TIMELINE duration (what the viewer experiences) — source span divided by speed
export const clipDurationSec = (c: Clip) => Math.max(0, (c.outSec - c.inSec) / (c.speed ?? 1));

// Where each clip lands on the assembled timeline (in frames + ms), in order.
export type PlacedClip = {clip: Clip; fromFrame: number; durFrames: number; startMs: number; endMs: number};

export const placeClips = (clips: Clip[], fps: number): PlacedClip[] => {
  let acc = 0;
  return clips.map((clip) => {
    const durFrames = Math.max(1, Math.round(clipDurationSec(clip) * fps));
    const fromFrame = acc;
    acc += durFrames;
    return {
      clip,
      fromFrame,
      durFrames,
      startMs: (fromFrame / fps) * 1000,
      endMs: ((fromFrame + durFrames) / fps) * 1000,
    };
  });
};

export const totalDurationFrames = (clips: Clip[], fps: number): number =>
  Math.max(1, clips.reduce((sum, c) => sum + Math.max(1, Math.round(clipDurationSec(c) * fps)), 0));

// ---- edits shared by the editor store and the MCP server ----

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
  const newId = `${clip.id}-s${Date.now().toString(36)}`;
  const kfs = clip.transform;
  let aK = kfs?.filter((k) => k.t < splitSrc);
  let bK = kfs?.filter((k) => k.t >= splitSrc);
  if (kfs?.length) {
    const pin = {t: splitSrc, ...sampleTransform(kfs, splitSrc)};
    if (!aK?.some((k) => Math.abs(k.t - splitSrc) < 0.06)) aK = [...(aK ?? []), pin];
    if (!bK?.some((k) => Math.abs(k.t - splitSrc) < 0.06)) bK = [{...pin}, ...(bK ?? [])];
  }
  const a = {...clip, outSec: splitSrc, transform: aK};
  const b = {...clip, id: newId, inSec: splitSrc, transform: bK};
  const remap: SegmentRemap = [
    {origId: clip.id, segId: clip.id, inMs: clip.inSec * 1000, outMs: splitSrc * 1000},
    {origId: clip.id, segId: newId, inMs: splitSrc * 1000, outMs: clip.outSec * 1000},
  ];
  return {clips: clips.flatMap((c) => (c.id === clip.id ? [a, b] : [c])), newId, remap};
}

// Autocut: replace clips with their speech segments (ends + internal pauses removed).
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
    if (!segs?.length) { out.push(c); continue; }
    segs.forEach((seg, k) => {
      const id = k === 0 ? c.id : uniq(`${c.id}-c${k}`);
      out.push({...c, id, inSec: seg.inSec, outSec: seg.outSec});
      remap.push({origId: c.id, segId: id, inMs: seg.inSec * 1000, outMs: seg.outSec * 1000});
    });
  }
  return {clips: out, remap};
}
