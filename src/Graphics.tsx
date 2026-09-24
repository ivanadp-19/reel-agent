import React from 'react';
import {Sequence, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig, Easing} from 'remotion';
import {TEMPLATES, type Graphic} from './graphicTemplates';
import {fontFamily} from './fonts';

const FONT = fontFamily('Montserrat');
// named faces the templates pick from (all in src/fonts.ts)
const FACE = {
  display: () => ({fontFamily: fontFamily('Montserrat'), fontWeight: 800}),
  condensed: () => ({fontFamily: fontFamily('Anton'), fontWeight: 400, letterSpacing: 1}),
  script: () => ({fontFamily: fontFamily('Caveat'), fontWeight: 700}),
  serif: () => ({fontFamily: fontFamily('Playfair Display'), fontWeight: 700}),
  'serif-italic': () => ({fontFamily: fontFamily('Instrument Serif'), fontWeight: 400, fontStyle: 'italic' as const}),
};
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

// one giant word at the top, or a tiled word wall with the middle row filled
const BIG = {lg: 150, xl: 210, xxl: 270};
const BigWord: React.FC<{props: any; accent: string}> = ({props, accent}) => {
  const a = useReveal(0, 10);
  const size = BIG[props.size as keyof typeof BIG] ?? BIG.xl;
  const face = FACE[props.font as keyof typeof FACE]?.() ?? FACE.display();
  const fill = props.color === 'accent' ? accent : '#fff';
  const text = props.upper ? String(props.text).toUpperCase() : props.text;
  const outline: React.CSSProperties = {color: 'transparent', WebkitTextStroke: `2px ${fill}`, opacity: 0.55};
  if (!props.repeat) {
    return <div style={{fontSize: size, lineHeight: 0.95, whiteSpace: 'nowrap', ...face, ...(props.color === 'outline' ? {...outline, opacity: 0.9} : {color: fill}), ...blurIn(a)}}>{text}</div>;
  }
  // wall: 5 rows, offset horizontally, the middle one filled
  return (
    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', overflow: 'hidden', width: '100%'}}>
      {[-2, -1, 0, 1, 2].map((r) => (
        <div key={r} style={{fontSize: size * 0.8, lineHeight: 0.9, whiteSpace: 'nowrap', transform: `translateX(${r * 60}px)`, ...face, ...(r === 0 ? {color: fill} : outline), opacity: (r === 0 ? 1 : 0.5) * interpolate(a, [0, 1], [0, 1]), filter: `blur(${(1 - a) * 8}px)`}}>
          {`${text}  ${text}  ${text}`}
        </div>
      ))}
    </div>
  );
};

// full-frame solid card with staggered lines; `grid` draws graph paper
const KineticCard: React.FC<{props: any; accent: string}> = ({props, accent}) => {
  const bg = props.bg === 'dark' ? '#0b0b0d' : props.bg === 'light' ? '#f3f3f0' : accent;
  const fg = props.bg === 'light' ? '#111' : '#fff';
  const face = FACE[props.font as keyof typeof FACE]?.() ?? FACE.condensed();
  return (
    <div style={{position: 'absolute', inset: 0, background: bg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '0 60px', textAlign: 'center', ...(props.grid ? {backgroundImage: `linear-gradient(${fg}22 1px, transparent 1px), linear-gradient(90deg, ${fg}22 1px, transparent 1px)`, backgroundSize: '96px 96px'} : {})}}>
      {props.lines.map((l: any, i: number) => (
        <CardLine key={i} i={i} text={l.text} color={l.dim ? `${fg}99` : fg} face={face} />
      ))}
    </div>
  );
};
const CardLine: React.FC<{i: number; text: string; color: string; face: React.CSSProperties}> = ({i, text, color, face}) => {
  const a = useReveal(2 + i * 4, 8);
  return <div style={{fontSize: 118, lineHeight: 1, textTransform: 'uppercase', color, ...face, opacity: a, transform: `translateY(${(1 - a) * 30}px)`}}>{text}</div>;
};

// outlined title that fills with the accent color left → right
const FillTitle: React.FC<{props: any; accent: string}> = ({props, accent}) => {
  const a = useReveal(0, 6);
  const fill = useReveal(6, 22);
  const face = FACE[props.font as keyof typeof FACE]?.() ?? FACE.condensed();
  const text = String(props.text).toUpperCase();
  const style: React.CSSProperties = {fontSize: 200, lineHeight: 1, whiteSpace: 'nowrap', ...face};
  return (
    <div style={{position: 'relative', display: 'inline-block', opacity: a}}>
      <div style={{...style, color: 'transparent', WebkitTextStroke: '3px rgba(255,255,255,0.6)'}}>{text}</div>
      <div style={{...style, position: 'absolute', inset: 0, color: accent, clipPath: `inset(0 ${(1 - fill) * 100}% 0 0)`}}>{text}</div>
    </div>
  );
};

// editorial title card: pill tag, script or serif-italic title, spaced-caps subtitle
const ScriptTitle: React.FC<{props: any; accent: string}> = ({props, accent}) => {
  const a = useReveal(0, 8);
  const b = useReveal(4, 10);
  const c = useReveal(9, 8);
  const face = FACE[props.font as keyof typeof FACE]?.() ?? FACE.script();
  return (
    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10}}>
      {props.tag ? <div style={{fontSize: 30, fontWeight: 600, letterSpacing: 2, textTransform: 'uppercase', color: '#fff', border: '2px solid rgba(255,255,255,0.8)', borderRadius: 999, padding: '6px 22px', opacity: a, textShadow: 'none'}}>{props.tag}</div> : null}
      <div style={{fontSize: 150, lineHeight: 1, color: '#fff', ...face, ...blurIn(b)}}>{props.title}</div>
      {props.sub ? <div style={{fontSize: 34, fontWeight: 600, letterSpacing: 5, textTransform: 'uppercase', color: accent, opacity: c}}>{props.sub}</div> : null}
    </div>
  );
};

// an image asset with a simple motion: pop in, then wiggle / float / spin
const Sticker: React.FC<{props: any}> = ({props}) => {
  const frame = useCurrentFrame();
  const {fps, width} = useVideoConfig();
  const pop = spring({frame, fps, config: {damping: 10, stiffness: 200, mass: 0.7}});
  const t = frame / fps;
  const motion =
    props.anim === 'wiggle' ? `rotate(${Math.sin(t * 9) * 4}deg)`
    : props.anim === 'float' ? `translateY(${Math.sin(t * 2.2) * 12}px)`
    : props.anim === 'spin' ? `rotate(${t * 60}deg)`
    : '';
  const scale = props.anim === 'none' ? 1 : interpolate(pop, [0, 1], [0.3, 1]);
  const src = /^https?:\/\//.test(props.src) ? props.src : staticFile(props.src);
  return (
    <Img
      src={src}
      style={{
        width: (width * props.widthPct) / 100,
        transform: `rotate(${props.rotate}deg) scale(${scale}) ${motion}`,
        transformOrigin: 'center',
        opacity: props.anim === 'none' ? 1 : pop,
        filter: 'drop-shadow(0 6px 18px rgba(0,0,0,0.35))',
      }}
    />
  );
};

const COMPONENTS: Record<string, React.FC<{props: any; accent: string}>> = {'hook-stack': HookStack, 'label-2tone': Label2Tone, stat: Stat, chapter: Chapter, 'big-word': BigWord, 'kinetic-card': KineticCard, 'fill-title': FillTitle, 'script-title': ScriptTitle, sticker: Sticker};

const One: React.FC<{g: Graphic; accent: string; durationInFrames: number}> = ({g, accent, durationInFrames}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const outF = Math.min(Math.round(fps * 0.15), Math.floor(durationInFrames / 3));
  const fadeOut = outF > 0 ? interpolate(frame, [durationInFrames - outF, durationInFrames], [1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}) : 1;
  const Comp = COMPONENTS[g.template];
  if (!Comp) return null;
  if (g.template === 'kinetic-card') {
    // covers the whole frame (a cutaway), no text-block positioning
    return (
      <div data-ab={`gfx:${g.id}`} style={{position: 'absolute', inset: 0, fontFamily: FONT, opacity: fadeOut, pointerEvents: 'none'}}>
        <Comp props={g.props} accent={accent} />
      </div>
    );
  }
  if (g.template === 'sticker') {
    // positioned by its center, not as a text block
    return (
      <div data-ab={`gfx:${g.id}`} style={{position: 'absolute', top: `${g.yPct ?? 50}%`, left: `${(g.props as any).xPct ?? 50}%`, transform: 'translate(-50%, -50%)', opacity: fadeOut, pointerEvents: 'none'}}>
        <Comp props={g.props} accent={accent} />
      </div>
    );
  }
  return (
    <div data-ab={`gfx:${g.id}`} style={{position: 'absolute', top: `${g.yPct ?? TEMPLATES[g.template].y}%`, left: 0, right: 0, padding: '0 60px', textAlign: 'center', fontFamily: FONT, textShadow: SHADOW, opacity: fadeOut, pointerEvents: 'none'}}>
      <Comp props={g.props} accent={accent} />
    </div>
  );
};

// ---- layouts: frame the base video ----
export type Box = {top: number; left: number; width: number; height: number}; // % of frame

// the layout active at the current frame (projected graphics of template 'layout')
export const useActiveLayout = (items: Graphic[]): Graphic | null => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const ms = (frame / fps) * 1000;
  return items.find((g) => g.template === 'layout' && ms >= g.startMs && ms < g.endMs) ?? null;
};

// where the video and the B-roll panel go for a layout
export const layoutBoxes = (props: any): {video: Box; panel: Box | null} => {
  const m = props.inset ?? 7;
  const full = {top: m, left: m, width: 100 - 2 * m, height: 100 - 2 * m};
  if (props.split === 'broll-bottom') return {video: {top: m, left: m, width: 100 - 2 * m, height: 46 - m}, panel: {top: 50, left: m, width: 100 - 2 * m, height: 50 - m}};
  if (props.split === 'broll-top') return {video: {top: 50, left: m, width: 100 - 2 * m, height: 50 - m}, panel: {top: m, left: m, width: 100 - 2 * m, height: 46 - m}};
  // a true circle: equal pixels, so height% = width% × (1080/1920)
  if (props.shape === 'circle') { const d = Math.min(full.width, full.height * (16 / 9)); return {video: {top: 50 - (d * 9) / 16 / 2, left: 50 - d / 2, width: d, height: (d * 9) / 16}, panel: null}; }
  return {video: full, panel: null};
};

const SHAPE_RADIUS: Record<string, string> = {rounded: '36px', arch: '50% 50% 28px 28px / 42% 42% 28px 28px', circle: '50%', phone: '64px', none: '0'};
const BORDER: Record<string, string> = {none: 'none', thin: '3px solid rgba(255,255,255,0.85)', glass: '1.5px solid rgba(255,255,255,0.35)', accent: '6px solid var(--accent)'};

// wraps the clip layer: canvas behind, the clips inside a shaped, inset frame
export const LayoutStage: React.FC<{items: Graphic[]; accentColor: string; children: React.ReactNode}> = ({items, accentColor, children}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const active = useActiveLayout(items);
  if (!active) return <>{children}</>;
  const p: any = active.props;
  const {video} = layoutBoxes(p);
  // ease the frame in from full-bleed over ~8 frames at the layout start
  const startF = Math.round((active.startMs / 1000) * fps);
  const a = interpolate(frame - startF, [0, 8], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: outCubic});
  const box = {top: video.top * a, left: video.left * a, width: 100 - (100 - video.width) * a, height: 100 - (100 - video.height) * a};
  const canvas =
    p.canvas === 'dark' ? '#0b0b0d'
    : p.canvas === 'light' ? '#f3f3f0'
    : p.canvas === 'gradient' ? `linear-gradient(160deg, ${accentColor} 0%, #ffffff 140%)`
    : accentColor;
  return (
    <div style={{position: 'absolute', inset: 0, background: canvas, ['--accent' as any]: accentColor}}>
      <div style={{position: 'absolute', top: `${box.top}%`, left: `${box.left}%`, width: `${box.width}%`, height: `${box.height}%`, overflow: 'hidden', borderRadius: SHAPE_RADIUS[p.shape] ?? '0', border: BORDER[p.border] ?? 'none', boxSizing: 'border-box', boxShadow: p.canvas === 'light' ? '0 20px 60px rgba(0,0,0,0.18)' : '0 24px 70px rgba(0,0,0,0.45)'}}>
        <div style={{position: 'absolute', inset: 0, width: '100%', height: '100%'}}>{children}</div>
      </div>
    </div>
  );
};

export const GraphicsLayer: React.FC<{items: Graphic[]; accentColor: string}> = ({items, accentColor}) => {
  const {fps} = useVideoConfig();
  if (!items?.length) return null;
  return (
    <>
      {items.filter((g) => g.template !== 'layout').map((g) => {
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
