import React from 'react';
import {staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {sampleTransform, type Clip} from './timeline';
import type {Grade} from './grade';
import {transitionFx} from './transitions';

// the cut into this clip and out of it: `clip` is the placed clip (the matte layer
// passes the footage clip), offset = frames between the clip start and this Sequence
export type TransitionCtx = {clip: Clip; next?: Clip; offset: number; durFrames: number};

// one clip's media with its keyframed zoom/pan transform applied, and its color
// grade (per-channel levels as an SVG filter, then saturation)
export const ClipMedia: React.FC<{clip: Clip; durFrames: number; Comp: React.ElementType; grade?: Grade | null; transition?: TransitionCtx}> = ({clip, durFrames, Comp, grade, transition}) => {
  const {fps} = useVideoConfig();
  const frame = useCurrentFrame(); // relative to this clip's Sequence
  const speed = clip.speed ?? 1;
  // keyframe times are source-relative → advance source-time at `speed`
  const {scale, x, y} = sampleTransform(clip.transform, clip.inSec + (frame / fps) * speed);
  const trimBefore = Math.round(clip.inSec * fps);
  const fid = `grade-${clip.id.replace(/[^\w-]/g, '_')}`;
  const fx = transition ? transitionFx(transition.clip, frame + transition.offset, transition.durFrames, transition.next) : null;
  const moving = fx && (fx.scale !== 1 || fx.dx !== 0 || fx.blur > 0);
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
      <div style={{width: '100%', height: '100%', transformOrigin: '50% 38%', transform: moving ? `translateX(${fx.dx}%) scale(${fx.scale})` : undefined, filter: moving && fx.blur > 0.2 ? `blur(${fx.blur.toFixed(1)}px)` : undefined}}>
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
    </div>
  );
};

