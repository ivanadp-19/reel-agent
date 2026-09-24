import React from 'react';
import {Sequence, interpolate, spring, useCurrentFrame, useVideoConfig, Easing} from 'remotion';
import {loadFont} from '@remotion/google-fonts/Montserrat';
import {TEMPLATES, type Graphic} from './graphicTemplates';

const {fontFamily} = loadFont('normal', {weights: ['600', '800'], subsets: ['latin', 'latin-ext']});
const FONT = `${fontFamily}, system-ui, sans-serif`;
const SHADOW = '0 4px 24px rgba(0,0,0,0.55), 0 0 60px rgba(0,0,0,0.35)';

const outCubic = Easing.out(Easing.cubic);
// 0→1 over `frames`, starting at `delay`
const useReveal = (delay: number, frames: number) => {
  const f = useCurrentFrame();
  return interpolate(f, [delay, delay + frames], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: outCubic});
};
// blur-in: unfocused and slightly low → sharp and in place
const blurIn = (a: number): React.CSSProperties => ({opacity: a, filter: `blur(${(1 - a) * 12}px)`, transform: `translateY(${(1 - a) * 22}px)`});

const SIZES = {sm: 60, md: 90, lg: 130, xl: 180};

const HookStack: React.FC<{props: any; accent: string}> = ({props, accent}) => (
  <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 0.98}}>
    {props.lines.map((l: any, i: number) => (
      <Line key={i} i={i} l={l} upper={props.upper} accent={accent} />
    ))}
  </div>
);
const Line: React.FC<{i: number; l: any; upper: boolean; accent: string}> = ({i, l, upper, accent}) => {
  const a = useReveal(i * 4, 9);
  return (
    <div style={{fontSize: SIZES[l.size as keyof typeof SIZES] ?? SIZES.lg, fontWeight: 800, color: l.accent ? accent : '#fff', textTransform: upper ? 'uppercase' : undefined, letterSpacing: -1, ...blurIn(a)}}>
      {l.text}
    </div>
  );
};

const Label2Tone: React.FC<{props: any; accent: string}> = ({props, accent}) => {
  const a = useReveal(0, 8);
  const b = useReveal(3, 8);
  const line: React.CSSProperties = {fontSize: 72, fontWeight: 800, lineHeight: 1.05, letterSpacing: -0.5};
  return (
    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
      <div style={{...line, color: '#fff', ...blurIn(a)}}>{props.top}</div>
      {props.bottom ? <div style={{...line, color: accent, ...blurIn(b)}}>{props.bottom}</div> : null}
    </div>
  );
};

// "104 m²" → count the number up, keep prefix/suffix and the decimal count
const countUp = (value: string, t: number) => {
  const m = value.match(/-?\d[\d,]*(\.\d+)?/);
  if (!m) return value;
  const raw = m[0];
  const n = parseFloat(raw.replace(/,/g, ''));
  const decimals = (m[1] ?? '.').length - 1;
  const cur = n * t;
  const text = raw.includes(',') ? cur.toLocaleString('en-US', {minimumFractionDigits: decimals, maximumFractionDigits: decimals}) : cur.toFixed(decimals);
  return value.slice(0, m.index) + text + value.slice(m.index! + raw.length);
};
const Stat: React.FC<{props: any; accent: string}> = ({props, accent}) => {
  const a = useReveal(0, 10);
  const c = useReveal(0, 18);
  const b = useReveal(6, 8);
  return (
    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
      <div style={{fontSize: 170, fontWeight: 800, lineHeight: 1, color: 'rgba(255,255,255,0.96)', letterSpacing: -3, ...blurIn(a)}}>{props.countUp ? countUp(props.value, c) : props.value}</div>
      {props.label ? <div style={{fontSize: 44, fontWeight: 600, color: accent, textTransform: 'uppercase', letterSpacing: 4, marginTop: 10, ...blurIn(b)}}>{props.label}</div> : null}
    </div>
  );
};

const Chapter: React.FC<{props: any; accent: string}> = ({props, accent}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const pop = spring({frame, fps, config: {damping: 11, stiffness: 190, mass: 0.7}});
  const a = useReveal(4, 8);
  return (
    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
      <div style={{fontSize: 40, fontWeight: 600, color: accent, textTransform: 'uppercase', letterSpacing: 6, ...blurIn(a)}}>{props.label}</div>
      <div style={{fontSize: 200, fontWeight: 800, lineHeight: 1, color: '#fff', letterSpacing: -4, opacity: pop, transform: `scale(${interpolate(pop, [0, 1], [0.6, 1])})`}}>{props.number}</div>
    </div>
  );
};

const COMPONENTS: Record<string, React.FC<{props: any; accent: string}>> = {'hook-stack': HookStack, 'label-2tone': Label2Tone, stat: Stat, chapter: Chapter};

const One: React.FC<{g: Graphic; accent: string; durationInFrames: number}> = ({g, accent, durationInFrames}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const outF = Math.min(Math.round(fps * 0.15), Math.floor(durationInFrames / 3));
  const fadeOut = outF > 0 ? interpolate(frame, [durationInFrames - outF, durationInFrames], [1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}) : 1;
  const Comp = COMPONENTS[g.template];
  if (!Comp) return null;
  return (
    <div data-ab={`gfx:${g.id}`} style={{position: 'absolute', top: `${g.yPct ?? TEMPLATES[g.template].y}%`, left: 0, right: 0, padding: '0 60px', textAlign: 'center', fontFamily: FONT, textShadow: SHADOW, opacity: fadeOut, pointerEvents: 'none'}}>
      <Comp props={g.props} accent={accent} />
    </div>
  );
};

export const GraphicsLayer: React.FC<{items: Graphic[]; accentColor: string}> = ({items, accentColor}) => {
  const {fps} = useVideoConfig();
  if (!items?.length) return null;
  return (
    <>
      {items.map((g) => {
        const from = Math.round((g.startMs / 1000) * fps);
        const dur = Math.max(1, Math.round(((g.endMs - g.startMs) / 1000) * fps));
        return (
          <Sequence key={`${g.id}@${from}`} from={from} durationInFrames={dur} layout="none" name={`gfx ${g.template}`}>
            <One g={g} accent={accentColor} durationInFrames={dur} />
          </Sequence>
        );
      })}
    </>
  );
};
