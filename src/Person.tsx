import React from 'react';
import {OffthreadVideo, Sequence, Video, getRemotionEnvironment, useVideoConfig} from 'remotion';
import {placeClips, type Clip} from './timeline';
import {ClipMedia} from './ClipMedia';

// A matte = the presenter cut out of a SOURCE span, stored as WebM with alpha.
// Anything drawn between the clip layer and this layer appears BEHIND the person.
export type Matte = {src: string; startMs: number; endMs: number; file: string};

// For every placed clip that overlaps a matte of the same source, play the
// matte with the clip's own trim, speed and keyframes so it lines up exactly.
export const PersonLayer: React.FC<{mattes: Matte[]; clips: Clip[]}> = ({mattes, clips}) => {
  const {fps} = useVideoConfig();
  if (!mattes?.length) return null;
  const Comp = getRemotionEnvironment().isRendering ? (p: any) => <OffthreadVideo {...p} transparent /> : Video;
  const out: React.ReactNode[] = [];
  for (const pc of placeClips(clips, fps)) {
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
          <ClipMedia clip={pseudo} durFrames={dur} Comp={Comp} />
        </Sequence>,
      );
    }
  }
  return <>{out}</>;
};
