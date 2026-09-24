import React from 'react';
import {staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {sampleTransform, type Clip} from './timeline';
import type {Grade} from './grade';
import {toneColor, transitionFx} from './transitions';


// the cut into this clip and out of it: `clip` is the placed clip (the matte layer
// passes the footage clip), offset = frames between the clip start and this Sequence
export type TransitionCtx = {clip: Clip; next?: Clip; offset: number; durFrames: number};

// one clip's media with its keyframed zoom/pan transform applied, and its color
// grade (per-channel levels as an SVG filter, then saturation)
export const ClipMedia: React.FC<{clip: Clip; durFrames: number; Comp: React.ElementType; grade?: Grade | null; accent?: string; transition?: TransitionCtx}> = ({clip, durFrames, Comp, grade, accent = '#FFB020', transition}) => {
  const {fps} = useVideoConfig();
  const frame = useCurrentFrame(); // relative to this clip's Sequence
  const speed = clip.speed ?? 1;
  // keyframe times are source-relative → advance source-time at `speed`
  const {scale, x, y} = sampleTransform(clip.transform, clip.inSec + (frame / fps) * speed);
  const trimBefore = Math.round(clip.inSec * fps);
  const fid = `grade-${clip.id.replace(/[^\w-]/g, '_')}`;
  const fx = transition ? transitionFx(transition.clip, frame + transition.offset, transition.durFrames, transition.next, fps) : null;
  const moving = fx && (fx.scale !== 1 || fx.dx !== 0 || fx.blur > 0 || !!fx.spin || !!fx.drop);
  // a directional smear: stretch along the angle + a softer blur (no extra video copies)
  const smear = fx?.angle != null && fx.blur > 0.2 ? `rotate(${fx.angle}deg) scaleX(${(1 + fx.blur / 36).toFixed(3)}) rotate(${-fx.angle}deg) ` : '';
  const spin = fx?.spin ? `rotate(${fx.spin.toFixed(2)}deg) ` : ''; // Prime's spin blur: a twist under the flash
  // Pop's cardDrop: the incoming clip falls in from above, rotating from −15° to level
  const drop = fx?.drop != null && fx.drop < 1 ? `translateY(${(-120 * (1 - fx.drop)).toFixed(1)}%) rotate(${(-15 * (1 - fx.drop)).toFixed(2)}deg) ` : '';
  // Impact II's chromatic split: a red and a cyan ghost either side (drop-shadows, no extra decodes)
  const split = fx?.rgb && fx.rgb > 0.3 ? `drop-shadow(${fx.rgb.toFixed(1)}px 0 rgba(255,0,90,0.75)) drop-shadow(${(-fx.rgb).toFixed(1)}px 0 rgba(0,220,255,0.75))` : '';
  // outgoing reveal: card = shrink to a rounded card sliding off left; split = four tiles flying to the corners;
  // fade = crossBlur (blur up, opacity down); shrink = under a cardDrop; mask = the clip-path the pack computed
  const exit = fx?.exit;
  const ease = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;
  // card: shrink first, then slide off left — the card is still on screen half-way through
  const exitStyle: React.CSSProperties | null = exit?.type === 'card'
    ? {transform: `translateX(${-125 * ease((exit.t - 0.3) / 0.7)}%) scale(${1 - 0.42 * ease(exit.t * 1.6)})`, borderRadius: 48 * ease(exit.t * 2), overflow: 'hidden', boxShadow: `0 30px 80px rgba(0,0,0,${0.5 * exit.t})`, transformOrigin: 'center'}
    : exit?.type === 'fade' ? {opacity: 1 - exit.t, filter: `blur(${(30 * exit.t).toFixed(1)}px)`}
    : exit?.type === 'shrink' ? {filter: `brightness(${(1 - 0.35 * ease(exit.t * 2)).toFixed(3)})`} // the card lands on it: it only dims (a shrink would show black edges without a canvas)
    : exit?.type === 'mask' ? {clipPath: exit.clipPath}
    : null;
  // Form's particles: the clip dissolves left → right through a seeded grain; the fringe of the front is
  // displaced by the same grain so it scatters like dust. th = the value below which a pixel is gone.
  const did = `dissolve-${clip.id.replace(/[^\w-]/g, '_')}`;
  // the front sits where a blurred white flood (starting at x) fades out; it sweeps left → right with t
  const dissolve = exit?.type === 'dissolve' ? {x: -25 + 145 * exit.t, disp: 6 + 50 * exit.t, seed: exit.seed ?? 1} : null;
  const fly = exit ? ease((exit.t - 0.12) / 0.88) : 0; // tiles pause a beat, then fly
  const tiles = exit?.type === 'split' ? [[0, 0, -1, -1], [50, 0, 1, -1], [0, 50, -1, 1], [50, 50, 1, 1]] : null; // left%, top%, fly direction
  return (
    <div
      data-ab={`clip:${clip.id}`}
      style={{width: '100%', height: '100%', overflow: 'hidden', transform: `translate(${x}%, ${y}%) scale(${scale})`, transformOrigin: 'center', ...(fx?.canvas ? {background: toneColor(fx.canvas.tone, accent), clipPath: fx.canvas.clip} : {})}}
    >
      {grade || dissolve ? (
        <svg width={0} height={0} style={{position: 'absolute'}} aria-hidden>
          {grade ? (
            <filter id={fid} colorInterpolationFilters="sRGB">
              <feComponentTransfer>
                <feFuncR type="linear" slope={grade.slope[0]} intercept={grade.intercept[0]} />
                <feFuncG type="linear" slope={grade.slope[1]} intercept={grade.intercept[1]} />
                <feFuncB type="linear" slope={grade.slope[2]} intercept={grade.intercept[2]} />
              </feComponentTransfer>
            </filter>
          ) : null}
          {dissolve ? (
            <filter id={did} x={0} y={0} width={1} height={1} colorInterpolationFilters="sRGB">
              <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves={3} seed={dissolve.seed} result="raw" />
              <feColorMatrix in="raw" type="matrix" values="1 0 0 0 0  1 0 0 0 0  1 0 0 0 0  0 0 0 0 1" result="noise" />
              <feFlood floodColor="#000" result="bg" />
              {/* primitive regions in px: a % here would resolve against the 0×0 svg, not the clip */}
              <feFlood floodColor="#fff" x={Math.round((dissolve.x / 100) * 1080)} y={0} width={3240} height={1920} result="white" />
              <feGaussianBlur in="white" stdDeviation="140 0" result="soft" />
              <feComposite in="soft" in2="bg" operator="over" result="ramp" />
              <feComposite in="noise" in2="ramp" operator="arithmetic" k1={0} k2={0.5} k3={1} k4={0} result="v" />
              <feColorMatrix in="v" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  1 0 0 0 -0.8" result="keepRaw" />
              <feComponentTransfer in="keepRaw" result="keep"><feFuncA type="linear" slope={400} intercept={0} /></feComponentTransfer>
              <feColorMatrix in="v" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  1 0 0 0 -0.95" result="coreRaw" />
              <feComponentTransfer in="coreRaw" result="core"><feFuncA type="linear" slope={400} intercept={0} /></feComponentTransfer>
              <feComposite in="keep" in2="core" operator="out" result="fringe" />
              <feDisplacementMap in="SourceGraphic" in2="raw" scale={dissolve.disp} xChannelSelector="R" yChannelSelector="G" result="shaken" />
              <feComposite in="SourceGraphic" in2="core" operator="in" result="solid" />
              <feComposite in="shaken" in2="fringe" operator="in" result="dust" />
              <feMerge><feMergeNode in="solid" /><feMergeNode in="dust" /></feMerge>
            </filter>
          ) : null}
        </svg>
      ) : null}
      {tiles ? tiles.map(([l, t, fx2, fy]) => (
        <div key={`${l}${t}`} style={{position: 'absolute', left: `${l}%`, top: `${t}%`, width: '50%', height: '50%', overflow: 'hidden', transform: `translate(${fx2 * 130 * fly}%, ${fy * 130 * fly}%) rotate(${fx2 * fy * 6 * fly}deg) scale(${1 - 0.15 * fly})`, boxShadow: '0 10px 40px rgba(0,0,0,0.45)'}}>
          <div style={{position: 'absolute', left: `${-l * 2}%`, top: `${-t * 2}%`, width: '200%', height: '200%'}}>
            <Comp src={staticFile(clip.src)} playbackRate={speed} trimBefore={trimBefore} trimAfter={trimBefore + Math.round(durFrames * speed)} muted style={{width: '100%', height: '100%', objectFit: 'cover', filter: grade ? `url(#${fid})${grade.saturation !== 1 ? ` saturate(${grade.saturation})` : ''}` : undefined}} />
          </div>
        </div>
      )) : null}
      <div style={{width: '100%', height: '100%', transformOrigin: '50% 38%', transform: moving ? `${drop}${spin}${smear}translateX(${fx.dx}%) scale(${fx.scale})` : undefined, filter: [moving && fx.blur > 0.2 ? `blur(${(fx.blur * (smear ? 0.4 : 1)).toFixed(1)}px)` : '', split, dissolve ? `url(#${did})` : ''].filter(Boolean).join(' ') || undefined, ...(exitStyle ?? {}), ...(fx?.enterMask ? {clipPath: fx.enterMask} : {}), ...(tiles ? {visibility: 'hidden' as const} : {})}}>
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
      {fx?.ring ? <div style={{position: 'absolute', left: `${(fx.ring.cx - fx.ring.r).toFixed(2)}%`, top: `${(fx.ring.cy - (fx.ring.r * 1080) / 1920).toFixed(2)}%`, width: `${(2 * fx.ring.r).toFixed(2)}%`, height: `${((2 * fx.ring.r * 1080) / 1920).toFixed(2)}%`, border: `4px solid ${accent}`, borderRadius: '50%', boxSizing: 'border-box', pointerEvents: 'none'}} /> : null}
    </div>
  );
};

