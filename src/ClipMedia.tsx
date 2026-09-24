import React from 'react';
import {staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {sampleTransform, type Clip} from './timeline';
import type {Grade} from './grade';

// one clip's media with its keyframed zoom/pan transform applied, and its color
// grade (per-channel levels as an SVG filter, then saturation)
export const ClipMedia: React.FC<{clip: Clip; durFrames: number; Comp: React.ElementType; grade?: Grade | null}> = ({clip, durFrames, Comp, grade}) => {
  const {fps} = useVideoConfig();
  const frame = useCurrentFrame(); // relative to this clip's Sequence
  const speed = clip.speed ?? 1;
  // keyframe times are source-relative → advance source-time at `speed`
  const {scale, x, y} = sampleTransform(clip.transform, clip.inSec + (frame / fps) * speed);
  const trimBefore = Math.round(clip.inSec * fps);
  const fid = `grade-${clip.id.replace(/[^\w-]/g, '_')}`;
  return (
    <div
      data-ab={`clip:${clip.id}`}
      style={{width: '100%', height: '100%', overflow: 'hidden', transform: `translate(${x}%, ${y}%) scale(${scale})`, transformOrigin: 'center'}}
    >
      {grade ? (
        <svg width={0} height={0} style={{position: 'absolute'}} aria-hidden>
          <filter id={fid} colorInterpolationFilters="sRGB">
            <feComponentTransfer>
              <feFuncR type="linear" slope={grade.slope[0]} intercept={grade.intercept[0]} />
              <feFuncG type="linear" slope={grade.slope[1]} intercept={grade.intercept[1]} />
              <feFuncB type="linear" slope={grade.slope[2]} intercept={grade.intercept[2]} />
            </feComponentTransfer>
          </filter>
        </svg>
      ) : null}
      <Comp
        src={staticFile(clip.src)}
        playbackRate={speed}
        trimBefore={trimBefore}
        // source frames consumed = timeline frames × speed (keeps the trimmed
        // span exactly as long as the Sequence — no black tail frame)
        trimAfter={trimBefore + Math.round(durFrames * speed)}
        acceptableTimeShiftInSeconds={0.5}
        muted={clip.muted || (clip.volume ?? 1) === 0}
        volume={clip.muted ? 0 : clip.volume ?? 1}
        style={{width: '100%', height: '100%', objectFit: 'cover', filter: grade ? `url(#${fid})${grade.saturation !== 1 ? ` saturate(${grade.saturation})` : ''}` : undefined}}
      />
    </div>
  );
};

