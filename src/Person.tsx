import React from 'react';
import {OffthreadVideo, Sequence, Video, getRemotionEnvironment, useCurrentFrame, useVideoConfig} from 'remotion';
import {placeClips, type Clip} from './timeline';
import {ClipMedia} from './ClipMedia';
import {gradeFor, type ProjectGrade} from './grade';
import type {Graphic} from './graphicTemplates';
import {useBrand} from './brand';

// A matte = the presenter cut out of a SOURCE span, stored as WebM with alpha.
// Anything drawn between the clip layer and this layer appears BEHIND the person.
export type Matte = {src: string; startMs: number; endMs: number; file: string};

// For every placed clip that overlaps a matte of the same source, play the
// matte with the clip's own trim, speed and keyframes so it lines up exactly.
// Chalk's scribbled outline: the matte drawn once more UNDER the person with eight offset drop-shadows in the
// outline color — the person covers the interior, the shadows stick out as a stroke; boil jitters the
// offsets every frame (deterministic in the frame number)
const OUTLINE_DIRS = [[1, 0], [0.7, 0.7], [0, 1], [-0.7, 0.7], [-1, 0], [-0.7, -0.7], [0, -1], [0.7, -0.7]];
const outlineFilter = (color: string, w: number, boil: boolean, frame: number) => OUTLINE_DIRS.map(([x, y], i) => {
  const j = boil ? (Math.sin(frame * 37.719 + i * 78.233) * 43758.5453) % 1 : 0;
  const r = w * (1 + 0.35 * j);
  return `drop-shadow(${(x * r).toFixed(1)}px ${(y * r).toFixed(1)}px 0 ${color})`;
}).join(' ');

export const PersonLayer: React.FC<{mattes: Matte[]; clips: Clip[]; grade?: ProjectGrade | null; outlines?: Graphic[]; accent?: string}> = ({mattes, clips, grade, outlines = [], accent = '#FFB020'}) => {
  const {fps} = useVideoConfig();
  const frame = useCurrentFrame();
  const kit = useBrand();
  const ms = (frame / fps) * 1000;
  const outline = outlines.find((g) => ms >= g.startMs && ms < g.endMs);
  const oc = outline ? (outline.props as any).color === 'light' ? kit.light : kit.accent : accent;
  if (!mattes?.length) return null;
  const Comp = getRemotionEnvironment().isRendering ? (p: any) => <OffthreadVideo {...p} transparent /> : Video;
  const out: React.ReactNode[] = [];
  const placed = placeClips(clips, fps);
  for (const [i, pc] of placed.entries()) {
    for (const m of mattes) {
      if (m.src !== pc.clip.src) continue;
      const inMs = pc.clip.inSec * 1000;
      const outMs = pc.clip.outSec * 1000;
      const a = Math.max(inMs, m.startMs);
      const b = Math.min(outMs, m.endMs);
      if (b <= a) continue;
      const speed = pc.clip.speed ?? 1;
      const from = pc.fromFrame + Math.round(((a - inMs) / speed / 1000) * fps);
      const dur = Math.max(1, Math.round(((b - a) / speed / 1000) * fps));
      // the matte file starts at m.startMs of the source: shift trim + keyframes into file time
      const shift = m.startMs / 1000;
      const pseudo: Clip = {...pc.clip, src: m.file, inSec: a / 1000 - shift, outSec: b / 1000 - shift, transform: pc.clip.transform?.map((k) => ({...k, t: k.t - shift})), muted: true};
      out.push(
        <Sequence key={`${pc.clip.id}@${m.file}@${from}`} from={from} durationInFrames={dur} layout="none" name={`person ${pc.clip.id}`}>
          {outline ? (
            <div style={{position: 'absolute', inset: 0, filter: outlineFilter(oc, (outline.props as any).widthPx ?? 6, !!(outline.props as any).boil, frame)}}>
              <ClipMedia clip={pseudo} durFrames={dur} Comp={Comp} grade={gradeFor(grade, pc.clip.src)} transition={{clip: pc.clip, next: placed[i + 1]?.clip, offset: from - pc.fromFrame, durFrames: pc.durFrames}} />
            </div>
          ) : null}
          <ClipMedia clip={pseudo} durFrames={dur} Comp={Comp} grade={gradeFor(grade, pc.clip.src)} transition={{clip: pc.clip, next: placed[i + 1]?.clip, offset: from - pc.fromFrame, durFrames: pc.durFrames}} />
        </Sequence>,
      );
    }
  }
  return <>{out}</>;
};
