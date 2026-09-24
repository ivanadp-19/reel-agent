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
  // a directional smear: stretch along the angle + a softer blur (no extra video copies)
  const smear = fx?.angle != null && fx.blur > 0.2 ? `rotate(${fx.angle}deg) scaleX(${(1 + fx.blur / 36).toFixed(3)}) rotate(${-fx.angle}deg) ` : '';
  // outgoing reveal: card = shrink to a rounded card sliding off left; split = four tiles flying to the corners
  const exit = fx?.exit;
  const ease = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;
  // card: shrink first, then slide off left — the card is still on screen half-way through
  const exitStyle: React.CSSProperties | null = exit?.type === 'card'
    ? {transform: `translateX(${-125 * ease((exit.t - 0.3) / 0.7)}%) scale(${1 - 0.42 * ease(exit.t * 1.6)})`, borderRadius: 48 * ease(exit.t * 2), overflow: 'hidden', boxShadow: `0 30px 80px rgba(0,0,0,${0.5 * exit.t})`, transformOrigin: 'center'}
    : null;
  const fly = exit ? ease((exit.t - 0.12) / 0.88) : 0; // tiles pause a beat, then fly
  const tiles = exit?.type === 'split' ? [[0, 0, -1, -1], [50, 0, 1, -1], [0, 50, -1, 1], [50, 50, 1, 1]] : null; // left%, top%, fly direction
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
      {tiles ? tiles.map(([l, t, fx2, fy]) => (
        <div key={`${l}${t}`} style={{position: 'absolute', left: `${l}%`, top: `${t}%`, width: '50%', height: '50%', overflow: 'hidden', transform: `translate(${fx2 * 130 * fly}%, ${fy * 130 * fly}%) rotate(${fx2 * fy * 6 * fly}deg) scale(${1 - 0.15 * fly})`, boxShadow: '0 10px 40px rgba(0,0,0,0.45)'}}>
          <div style={{position: 'absolute', left: `${-l * 2}%`, top: `${-t * 2}%`, width: '200%', height: '200%'}}>
            <Comp src={staticFile(clip.src)} playbackRate={speed} trimBefore={trimBefore} trimAfter={trimBefore + Math.round(durFrames * speed)} muted style={{width: '100%', height: '100%', objectFit: 'cover', filter: grade ? `url(#${fid})${grade.saturation !== 1 ? ` saturate(${grade.saturation})` : ''}` : undefined}} />
          </div>
        </div>
      )) : null}
      <div style={{width: '100%', height: '100%', transformOrigin: '50% 38%', transform: moving ? `${smear}translateX(${fx.dx}%) scale(${fx.scale})` : undefined, filter: moving && fx.blur > 0.2 ? `blur(${(fx.blur * (smear ? 0.4 : 1)).toFixed(1)}px)` : undefined, ...(exitStyle ?? {}), ...(tiles ? {visibility: 'hidden' as const} : {})}}>
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

