import React, {createContext, useContext} from 'react';
import {Sequence, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig, Easing} from 'remotion';
import {CENTERED, DECOR_FULL, FULL_FRAME, STAR_PX, TEMPLATES, oversizedPx, type Graphic, type Out, type Reveal} from './graphicTemplates';
import {TEXT_REVEALS, arrive, layoutIn, layoutOut, leave, lifeFx, ms, revealText, scrambleChar, unfold, windowTrail, type ArriveKind, type LayoutIn, type LeaveKind, type TextReveal} from './motion';
import {seedOf} from './transitions';
import {fontFamily, heaviest, type FontFamily} from './fonts';
import {ink, legible, useBrand} from './brand';
import {ensureProjectFont} from './projectFont';
import {PRESETS} from './captionPresets';
import {fitSize, textWidthEm} from './textFit';

// named faces the templates pick from (all in src/fonts.ts); a brand kit's
// headline font replaces `display`
type FaceName = 'display' | 'condensed' | 'script' | 'serif' | 'serif-italic';
const FACES: Record<FaceName, {family: FontFamily; weight: number; italic?: boolean; spacing?: number}> = {
  display: {family: 'Montserrat', weight: 800},
  condensed: {family: 'Anton', weight: 400, spacing: 1},
  script: {family: 'Caveat', weight: 700},
  serif: {family: 'Playfair Display', weight: 700},
  'serif-italic': {family: 'Instrument Serif', weight: 400, italic: true},
};
type Face = {family: string; style: React.CSSProperties}; // a catalog family or a brand kit's client font
const useFace = (name: unknown, fallback: FaceName = 'display'): Face => {
  const kit = useBrand();
  const key = (typeof name === 'string' && name in FACES ? name : fallback) as FaceName;
  const f: {family: string; weight: number; italic?: boolean; spacing?: number} = key === 'display' && kit.display ? {family: kit.display, weight: heaviest(kit.display, kit.fontFiles)} : key === 'script' && kit.script ? {family: kit.script, weight: heaviest(kit.script)} : FACES[key];
  return {family: f.family, style: {fontFamily: fontFamily(f.family), fontWeight: f.weight, ...(f.italic ? {fontStyle: 'italic' as const} : {}), ...(f.spacing ? {letterSpacing: f.spacing} : {})}};
};
const SHADOW = '0 4px 24px rgba(0,0,0,0.55), 0 0 60px rgba(0,0,0,0.35)';

const outCubic = Easing.out(Easing.cubic);

// how the graphic being drawn arrives and leaves (set by One from the graphic or the caption pack)
type Gfx = {reveal: Reveal; out: Out; framesLeft: number; seed: number; yPct?: number};
const GfxContext = createContext<Gfx>({reveal: 'auto', out: 'auto', framesLeft: 1e6, seed: 1});
// the template's own staggered entrance runs for 'auto' and 'blur' (its blur-in IS the catalog's 5–9 f blur-in)
// and under the per-character reveals (Letters handles the title, the tag / subtitle still fade in after it);
// a block reveal (drop, band, wipe…) replaces it, so the template's parts are simply there
const ownEntrance = (r: Reveal) => r === 'auto' || r === 'blur' || TEXT_REVEALS.has(r);
// 0→1 over `frames`, starting at `delay`
const useReveal = (delay: number, frames: number) => {
  const f = useCurrentFrame();
  const g = useContext(GfxContext);
  if (!ownEntrance(g.reveal)) return 1;
  return interpolate(f, [delay, delay + frames], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: outCubic});
};

// a title's text, character by character when the reveal (letters, typewriter, shuffle, tracking) or the
// exit (letters: last first, scaling to 0) works per character; otherwise one plain span
const seg = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
const Letters: React.FC<{text: string; style?: React.CSSProperties}> = ({text, style}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const g = useContext(GfxContext);
  const perChar = TEXT_REVEALS.has(g.reveal) || g.out === 'letters';
  if (!perChar) return <span style={style}>{text}</span>;
  const chars = [...seg.segment(text)].map((x) => x.segment);
  const n = chars.length;
  const r = TEXT_REVEALS.has(g.reveal) ? revealText(g.reveal as TextReveal, frame, fps, n) : null;
  const cut = g.out === 'letters' ? leave('letters', g.framesLeft, fps).letterCut : 0;
  const shown = r ? r.shown : n;
  const head = Math.floor(shown);
  return (
    <span style={{...style, whiteSpace: 'pre'}}>
      {chars.map((ch, i) => {
        const gone = i >= n - cut;
        const leading = !!r && i === head && shown < n; // the char arriving right now
        const frac = shown - head;
        const later = !!r && i > head;
        const glyph = r?.scramble && i >= head ? scrambleChar(g.seed, i, frame) : ch;
        const opacity = gone ? 0 : later && !r?.scramble ? 0 : leading ? (r?.scramble ? 1 : Math.max(0.15, frac)) : r?.scramble && i >= head ? 0.7 : 1;
        const blur = leading && r ? r.blur * (1 - frac) : 0;
        // continuous per-character reveals (.aegraphic bounceChars / riseChars) drive their own transform
        const fx = r?.charFx && !gone ? r.charFx(i) : null;
        const charOpacity = fx ? fx.opacity : opacity;
        const charBlur = fx ? fx.blur : blur;
        const charTransform = fx
          ? `translateY(${fx.dy.toFixed(1)}px) scale(${fx.scale.toFixed(3)}) rotate(${fx.rotate.toFixed(1)}deg)`
          : gone
            ? 'scale(0)'
            : undefined;
        return (
          <span key={i} style={{display: 'inline-block', whiteSpace: 'pre', opacity: charOpacity, filter: charBlur > 0.2 ? `blur(${charBlur.toFixed(1)}px)` : undefined, transform: charTransform, letterSpacing: r?.tracking ? `${r.tracking}em` : undefined}}>{glyph}</span>
        );
      })}
    </span>
  );
};
// blur-in: unfocused and slightly low → sharp and in place
const blurIn = (a: number): React.CSSProperties => ({opacity: a, filter: `blur(${(1 - a) * 12}px)`, transform: `translateY(${(1 - a) * 22}px)`});

// line widths: src/textFit.ts

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
  const face = useFace('display');
  const base = SIZES[l.size as keyof typeof SIZES] ?? SIZES.lg;
  return (
    <div style={{...face.style, fontSize: fitSize(upper ? String(l.text).toUpperCase() : l.text, base, face.family), color: l.accent ? accent : '#fff', textTransform: upper ? 'uppercase' : undefined, letterSpacing: -1, whiteSpace: 'nowrap', ...blurIn(a)}}>
      <Letters text={l.text} />
    </div>
  );
};

const Label2Tone: React.FC<{props: any; accent: string}> = ({props, accent}) => {
  const a = useReveal(0, 8);
  const b = useReveal(3, 8);
  const face = useFace('display');
  // a long line shrinks (down to 52 px) before it is allowed to wrap
  const line = (text: string): React.CSSProperties => ({...face.style, fontSize: fitSize(text, 72, face.family, 940, 52), lineHeight: 1.05, letterSpacing: -0.5, textAlign: 'center'});
  // glass plate: a soft dark backing that fades in with the first line (run 6:
  // the accent line fought a floral blouse); 'none' keeps the bare text
  const plate: React.CSSProperties = props.plate === 'none' ? {} : {background: 'rgba(8,10,14,0.42)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', borderRadius: 26, padding: '16px 36px 20px', boxShadow: '0 10px 40px rgba(0,0,0,0.25)', opacity: a};
  return (
    <div style={{display: 'flex', justifyContent: 'center'}}>
      <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', ...plate}}>
        <div style={{...line(props.top), color: '#fff', ...blurIn(a)}}><Letters text={props.top} /></div>
        {props.bottom ? <div style={{...line(props.bottom), color: accent, ...blurIn(b)}}><Letters text={props.bottom} /></div> : null}
      </div>
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
  const face = useFace('display');
  return (
    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
      <div style={{...face.style, fontSize: fitSize(props.value, 170, face.family, 960), lineHeight: 1, color: 'rgba(255,255,255,0.96)', letterSpacing: -3, whiteSpace: 'nowrap', ...blurIn(a)}}>{props.countUp ? countUp(props.value, c) : props.value}</div>
      {props.label ? <div style={{fontSize: 44, fontWeight: 600, color: accent, textTransform: 'uppercase', letterSpacing: 4, marginTop: 10, ...blurIn(b)}}>{props.label}</div> : null}
    </div>
  );
};

const Chapter: React.FC<{props: any; accent: string}> = ({props, accent}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const pop = spring({frame, fps, config: {damping: 11, stiffness: 190, mass: 0.7}});
  const a = useReveal(4, 8);
  const face = useFace('display');
  return (
    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
      <div style={{fontSize: 40, fontWeight: 600, color: accent, textTransform: 'uppercase', letterSpacing: 6, ...blurIn(a)}}>{props.label}</div>
      <div style={{...face.style, fontSize: 200, lineHeight: 1, color: '#fff', letterSpacing: -4, opacity: pop, transform: `scale(${interpolate(pop, [0, 1], [0.6, 1])})`}}>{props.number}</div>
    </div>
  );
};

// one giant word at the top, or a tiled word wall with the middle row filled
const BIG = {lg: 150, xl: 210, xxl: 270};
const BigWord: React.FC<{props: any; accent: string}> = ({props, accent}) => {
  const a = useReveal(0, 10);
  const {family, style: face} = useFace(props.font);
  const fill = props.color === 'accent' ? accent : '#fff';
  const text = props.upper ? String(props.text).toUpperCase() : props.text;
  const size = fitSize(text, BIG[props.size as keyof typeof BIG] ?? BIG.xl, family, 1000);
  const outline: React.CSSProperties = {color: 'transparent', WebkitTextStroke: `2px ${fill}`, opacity: 0.55};
  if (!props.repeat) {
    return <div style={{fontSize: size, lineHeight: 0.95, whiteSpace: 'nowrap', ...face, ...(props.color === 'outline' ? {...outline, opacity: 0.9} : {color: fill}), ...blurIn(a)}}><Letters text={text} /></div>;
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
  const kit = useBrand();
  const bg = props.bg === 'dark' ? kit.dark : props.bg === 'light' ? kit.light : kit.accent;
  const fg = props.bg === 'light' ? '#111' : '#fff';
  const face = useFace(props.font, 'condensed');
  return (
    <div style={{position: 'absolute', inset: 0, background: bg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '0 60px', textAlign: 'center', ...(props.grid ? {backgroundImage: `linear-gradient(${fg}22 1px, transparent 1px), linear-gradient(90deg, ${fg}22 1px, transparent 1px)`, backgroundSize: '96px 96px'} : {})}}>
      {props.lines.map((l: any, i: number) => (
        <CardLine key={i} i={i} text={l.text} color={l.dim ? `${fg}99` : fg} face={face} />
      ))}
    </div>
  );
};
const CardLine: React.FC<{i: number; text: string; color: string; face: Face}> = ({i, text, color, face}) => {
  const a = useReveal(2 + i * 4, 8);
  return <div style={{fontSize: fitSize(String(text).toUpperCase(), 118, face.family, 940), lineHeight: 1, textTransform: 'uppercase', whiteSpace: 'nowrap', color, ...face.style, opacity: a, transform: `translateY(${(1 - a) * 30}px)`}}><Letters text={text} /></div>;
};

// outlined title that fills with the accent color left → right
const FillTitle: React.FC<{props: any; accent: string}> = ({props, accent}) => {
  const a = useReveal(0, 6);
  const fill = useReveal(6, 22);
  const face = useFace(props.font, 'condensed');
  const text = String(props.text).toUpperCase();
  const style: React.CSSProperties = {fontSize: fitSize(text, 200, face.family, 1000), lineHeight: 1, whiteSpace: 'nowrap', ...face.style};
  return (
    <div style={{position: 'relative', display: 'inline-block', opacity: a}}>
      <div style={{...style, color: 'transparent', WebkitTextStroke: '3px rgba(255,255,255,0.6)'}}><Letters text={text} /></div>
      <div style={{...style, position: 'absolute', inset: 0, color: accent, clipPath: `inset(0 ${(1 - fill) * 100}% 0 0)`}}><Letters text={text} /></div>
    </div>
  );
};

// editorial title card: pill tag, script or serif-italic title, spaced-caps subtitle
const ScriptTitle: React.FC<{props: any; accent: string}> = ({props, accent}) => {
  const a = useReveal(0, 8);
  const b = useReveal(4, 10);
  const c = useReveal(9, 8);
  const face = useFace(props.font, 'script');
  return (
    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10}}>
      {props.tag ? <div style={{fontSize: 30, fontWeight: 600, letterSpacing: 2, textTransform: 'uppercase', color: '#fff', border: '2px solid rgba(255,255,255,0.8)', borderRadius: 999, padding: '6px 22px', opacity: a, textShadow: 'none'}}>{props.tag}</div> : null}
      <div style={{fontSize: fitSize(props.title, 150, face.family, 960), lineHeight: 1, whiteSpace: 'nowrap', color: '#fff', ...face.style, ...blurIn(b)}}><Letters text={props.title} /></div>
      {props.sub ? <div style={{fontSize: 34, fontWeight: 600, letterSpacing: 5, textTransform: 'uppercase', color: accent, opacity: c}}>{props.sub}</div> : null}
    </div>
  );
};

// one word wider than the frame, cropped by both edges, drifting sideways
const Oversized: React.FC<{props: any; accent: string}> = ({props, accent}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const a = useReveal(0, 10);
  const face = useFace(props.font, 'condensed');
  const text = String(props.text).toUpperCase();
  const fill = props.color === 'text' || props.color === 'outline' ? '#fff' : accent;
  const drift = props.drift ? 40 - (frame / fps) * 40 : 0; // px, slow leftward pan
  const look: React.CSSProperties = props.color === 'outline' ? {color: 'transparent', WebkitTextStroke: `4px ${fill}`, textShadow: 'none'} : {color: fill};
  return (
    <div style={{display: 'flex', justifyContent: 'center', margin: '0 -60px'}}>
      <div style={{...face.style, ...look, fontSize: oversizedPx(text, props.font, face.family), lineHeight: 0.86, whiteSpace: 'nowrap', opacity: a, filter: `blur(${(1 - a) * 10}px)`, transform: `translateX(${drift}px) scale(${interpolate(a, [0, 1], [1.08, 1])})`}}><Letters text={text} /></div>
    </div>
  );
};

// small widely spaced capitals between thin rules, optional accent line under it
const ChapterCaps: React.FC<{props: any; accent: string}> = ({props, accent}) => {
  const a = useReveal(0, 14);
  const b = useReveal(8, 10);
  const spacing = interpolate(a, [0, 1], [0.7, 0.38]); // em, the letters settle together
  const text = String(props.text).toUpperCase();
  const room = props.rules ? 720 : 940;
  const size = Math.max(24, Math.min(40, Math.floor(room / (textWidthEm(text, 'Montserrat') + 0.38 * text.length))));
  const rule = <div style={{height: 2, width: 90, background: 'rgba(255,255,255,0.85)', transform: `scaleX(${a})`}} />;
  return (
    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 28, opacity: a}}>
        {props.rules ? rule : null}
        <div style={{fontSize: size, fontWeight: 600, letterSpacing: `${spacing}em`, marginRight: `-${spacing}em`, color: '#fff', whiteSpace: 'nowrap'}}><Letters text={text} /></div>
        {props.rules ? rule : null}
      </div>
      {props.sub ? <div style={{fontSize: 34, fontWeight: 700, color: accent, letterSpacing: '0.12em', textTransform: 'uppercase', whiteSpace: 'nowrap', ...blurIn(b)}}>{props.sub}</div> : null}
    </div>
  );
};

// comic starburst: a parametric 14-point star (drawn in code, not an asset) with a shout inside
const STAR_POINTS = Array.from({length: 28}, (_, i) => {
  const r = i % 2 ? 40 : 50;
  const t = (i / 28) * Math.PI * 2 - Math.PI / 2;
  return `${(50 + r * Math.cos(t)).toFixed(2)},${(50 + r * Math.sin(t)).toFixed(2)}`;
}).join(' ');
const Starburst: React.FC<{props: any; accent: string}> = ({props, accent}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const kit = useBrand();
  const face = useFace('display');
  const d = STAR_PX[props.size] ?? STAR_PX.md;
  const pop = spring({frame, fps, config: {damping: 9, stiffness: 220, mass: 0.6}});
  const wiggle = Math.sin((frame / fps) * 7) * 2.5;
  const bg = props.color === 'light' ? kit.light : props.color === 'dark' ? kit.dark : kit.accent;
  const text = String(props.text).toUpperCase();
  // stamp (Pop): lands from 1.25× to 1 in ~3 frames and then holds still; pop springs in and wiggles
  const stamp = props.anim === 'stamp';
  const land = stamp ? interpolate(frame, [0, ms(fps, 125)], [1.25, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: outCubic}) : 1;
  return (
    <div style={{width: d, height: d, position: 'relative', opacity: stamp ? 1 : Math.min(1, pop * 2), transform: stamp ? `rotate(${props.rotate}deg) scale(${land.toFixed(3)})` : `rotate(${props.rotate + wiggle}deg) scale(${interpolate(pop, [0, 1], [0.2, 1])})`}}>
      <svg viewBox="0 0 100 100" width={d} height={d} style={{position: 'absolute', inset: 0, overflow: 'visible', filter: 'drop-shadow(6px 8px 0 rgba(0,0,0,0.35))'}}>
        <polygon points={STAR_POINTS} fill={bg} stroke="#111" strokeWidth={2.2} strokeLinejoin="round" />
      </svg>
      <div style={{position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', ...face.style, fontSize: fitSize(text, Math.round(d * 0.3), face.family, Math.round(d * 0.6)), lineHeight: 1, letterSpacing: -1, color: ink(bg), textShadow: 'none', whiteSpace: 'nowrap'}}>{text}</div>
    </div>
  );
};

// map pin + place in a glass pill
const LocationTag: React.FC<{props: any; accent: string}> = ({props, accent}) => {
  const a = useReveal(0, 9);
  const b = useReveal(5, 9);
  const face = useFace('display');
  const {accent: fill} = useBrand();
  return (
    <div style={{display: 'inline-flex', alignItems: 'center', gap: 24, padding: '18px 36px 18px 26px', borderRadius: 999, background: 'rgba(0,0,0,0.38)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)', border: '1.5px solid rgba(255,255,255,0.3)', textShadow: 'none', ...blurIn(a)}}>
      <div style={{width: 44, height: 44, flex: '0 0 auto', borderRadius: '50% 50% 50% 0', transform: 'rotate(-45deg)', background: fill, display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
        <div style={{width: 15, height: 15, borderRadius: '50%', background: ink(fill)}} />
      </div>
      <div style={{display: 'flex', flexDirection: 'column', alignItems: 'flex-start', textAlign: 'left'}}>
        <div style={{...face.style, fontSize: fitSize(props.place, 52, face.family, 700, 34), lineHeight: 1.08, color: '#fff', whiteSpace: 'nowrap'}}>{props.place}</div>
        {props.sub ? <div style={{fontSize: fitSize(props.sub, 30, 'Montserrat', 700, 22), fontWeight: 600, color: 'rgba(255,255,255,0.82)', letterSpacing: 1, whiteSpace: 'nowrap', opacity: b}}>{props.sub}</div> : null}
      </div>
    </div>
  );
};

// price: label above, the value on an accent bar that wipes in, a note below
const Price: React.FC<{props: any; accent: string}> = ({props, accent}) => {
  const a = useReveal(0, 8);
  const bar = useReveal(3, 10);
  const c = useReveal(3, 20);
  const b = useReveal(10, 8);
  const face = useFace('display');
  const {accent: fill} = useBrand();
  return (
    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10}}>
      {props.label ? <div style={{fontSize: 36, fontWeight: 700, letterSpacing: '0.3em', marginRight: '-0.3em', textTransform: 'uppercase', color: '#fff', ...blurIn(a)}}>{props.label}</div> : null}
      <div style={{position: 'relative', padding: '6px 34px'}}>
        <div style={{position: 'absolute', inset: 0, background: fill, borderRadius: 16, transform: `scaleX(${bar})`, transformOrigin: 'left center', boxShadow: '0 12px 40px rgba(0,0,0,0.35)'}} />
        <div style={{position: 'relative', ...face.style, fontSize: fitSize(props.value, 140, face.family, 860), lineHeight: 1.05, letterSpacing: -2, color: ink(fill), textShadow: 'none', whiteSpace: 'nowrap', opacity: bar}}>{props.countUp ? countUp(props.value, c) : props.value}</div>
      </div>
      {props.note ? <div style={{fontSize: 34, fontWeight: 600, color: 'rgba(255,255,255,0.92)', whiteSpace: 'nowrap', ...blurIn(b)}}>{props.note}</div> : null}
    </div>
  );
};

// closing card: canvas slides up, logo pops, title blurs in, the CTA pill pulses once
const EndCard: React.FC<{props: any; accent: string}> = ({props, accent}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const kit = useBrand();
  const face = useFace('display');
  const bg = props.bg === 'accent' ? kit.accent : props.bg === 'light' ? kit.light : kit.dark;
  const fg = ink(bg);
  const card = useReveal(0, 10);
  const logo = spring({frame: frame - 6, fps, config: {damping: 11, stiffness: 180, mass: 0.7}});
  const title = useReveal(10, 10);
  const cta = spring({frame: frame - 18, fps, config: {damping: 8, stiffness: 160, mass: 0.8}});
  const pillBg = props.bg === 'accent' ? fg : kit.accent;
  return (
    <div style={{position: 'absolute', inset: 0, background: bg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 44, padding: '0 90px', textAlign: 'center', textShadow: 'none', opacity: card, transform: `translateY(${(1 - card) * 80}px)`}}>
      {kit.logo ? <Img src={staticFile(kit.logo)} style={{maxWidth: 360, maxHeight: 220, objectFit: 'contain', opacity: Math.min(1, logo * 1.5), transform: `scale(${interpolate(logo, [0, 1], [0.6, 1])})`}} /> : null}
      {/* the title gets two lines of room before it shrinks */}
      <div style={{...face.style, fontSize: fitSize(props.title, 104, face.family, 1700, 60), lineHeight: 1.05, color: fg, maxWidth: 900, ...blurIn(title)}}><Letters text={props.title} /></div>
      {props.cta ? <div style={{fontSize: 44, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', color: ink(pillBg), background: pillBg, borderRadius: 999, padding: '22px 56px', opacity: Math.min(1, cta * 1.5), transform: `scale(${interpolate(cta, [0, 1], [0.5, 1])})`}}>{props.cta}</div> : null}
      {props.handle ? <div style={{fontSize: 38, fontWeight: 600, color: fg, opacity: 0.8 * title}}>{props.handle}</div> : null}
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
  // unfold (Paper II): a crumpled ball beside the head travels to its place while it scales up, spins level and sharpens;
  // over the last 4 frames it folds back toward the head
  const g = useContext(GfxContext);
  const outF = ms(fps, 170);
  const leaving = props.anim === 'unfold' && g.framesLeft < outF;
  const u = props.anim === 'unfold' ? unfold(leaving ? outF - g.framesLeft : frame, fps, leaving) : null;
  const {height} = useVideoConfig();
  const travel = u ? {x: ((props.fromXPct - props.xPct) / 100) * width * (1 - u.travel), y: ((props.fromYPct - (g.yPct ?? 50)) / 100) * height * (1 - u.travel)} : null;
  const scale = props.anim === 'none' ? 1 : u ? u.scale : interpolate(pop, [0, 1], [0.3, 1]);
  const src = /^https?:\/\//.test(props.src) ? props.src : staticFile(props.src);
  return (
    <Img
      src={src}
      style={{
        width: (width * props.widthPct) / 100,
        transform: `${travel ? `translate(${travel.x.toFixed(1)}px, ${travel.y.toFixed(1)}px) ` : ''}rotate(${props.rotate + (u ? -40 * (1 - u.travel) : 0)}deg) scale(${scale}) ${motion}`,
        transformOrigin: 'center',
        opacity: props.anim === 'none' || u ? 1 : pop,
        filter: `drop-shadow(0 6px 18px rgba(0,0,0,0.35))${u && u.travel < 1 ? ` blur(${(6 * (1 - u.travel)).toFixed(1)}px) contrast(${(1 + 0.6 * (1 - u.travel)).toFixed(2)})` : ''}`,
      }}
    />
  );
};

// a typographic ornament, static
const Ornament: React.FC<{props: any; accent: string}> = ({props, accent}) => {
  const kit = useBrand();
  const color = props.color === 'accent' ? kit.accent : props.color === 'dark' ? kit.dark : '#ffffff';
  return <div style={{fontSize: props.size, lineHeight: 1, color, textShadow: '0 2px 12px rgba(0,0,0,0.35)'}}>{props.glyph}</div>;
};

// thin static rules along the margins (Form) or one across the frame (Elevate)
const Rules: React.FC<{props: any; accent: string}> = ({props}) => {
  const kit = useBrand();
  const color = props.color === 'accent' ? kit.accent : 'rgba(255,255,255,0.75)';
  const inset = `${props.inset}%`;
  if (props.orientation === 'vertical') return <>{[inset, `calc(100% - ${inset})`].map((x) => <div key={x} style={{position: 'absolute', top: 0, bottom: 0, left: x, width: props.widthPx, marginLeft: -props.widthPx / 2, background: color}} />)}</>;
  return <div style={{position: 'absolute', left: `${(100 - props.lengthPct) / 2}%`, width: `${props.lengthPct}%`, top: '50%', height: props.widthPx, background: color}} />;
};
// the person outline is drawn by the matte layer (src/Person.tsx); here it takes no space
const PersonOutlineStub: React.FC<{props: any; accent: string}> = () => null;

// Focus: a full-width accent band with bold white capitals (rises with reveal 'band', drops with out 'band')
const BandTitle: React.FC<{props: any; accent: string}> = ({props}) => {
  const kit = useBrand();
  const face = useFace(props.font, 'display');
  const text = String(props.text).toUpperCase();
  return (
    <div style={{margin: '0 -60px', background: kit.accent, padding: '26px 0', textAlign: 'center', textShadow: 'none'}}>
      <div style={{...face.style, fontSize: fitSize(text, 96, face.family, 1000), lineHeight: 1, letterSpacing: 1, color: ink(kit.accent), whiteSpace: 'nowrap'}}><Letters text={text} /></div>
    </div>
  );
};

// Prime: a thin glowing rectangle that draws on in 3 frames, tilted, oscillating ±3° with a copy trailing 4 frames behind
const NeonFrame: React.FC<{props: any; accent: string}> = ({props}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const kit = useBrand();
  const w = (1080 * props.widthPct) / 100, h = (1920 * props.heightPct) / 100, per = 2 * (w + h);
  const draw = interpolate(frame, [0, ms(fps, 125)], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: outCubic});
  const rot = (f: number) => props.tilt + lifeFx('oscillate', f, fps).rotate;
  const Rect = ({f, opacity}: {f: number; opacity: number}) => (
    <svg width={w} height={h} style={{position: 'absolute', inset: 0, overflow: 'visible', transform: `rotate(${rot(f).toFixed(2)}deg)`, opacity}}>
      <rect x={2} y={2} width={w - 4} height={h - 4} fill="none" stroke={kit.accent} strokeWidth={4} strokeDasharray={per} strokeDashoffset={per * (1 - draw)} style={{filter: `drop-shadow(0 0 6px ${kit.accent}) drop-shadow(0 0 22px ${kit.accent}aa)`}} />
    </svg>
  );
  return <div style={{width: w, height: h, position: 'relative'}}>{frame >= 4 ? <Rect f={frame - 4} opacity={0.35} /> : null}<Rect f={frame} opacity={1} /></div>;
};

// Sketch / Chalk: a stroke that draws itself around a point; boil redraws it every frame
const SCRIBBLE_COLOR: Record<string, string> = {light: '#F3EFE4', dark: '#1b1b1b'};
const Scribble: React.FC<{props: any; accent: string}> = ({props}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const kit = useBrand();
  const g = useContext(GfxContext);
  const w = (1080 * props.widthPct) / 100, h = (1920 * props.heightPct) / 100;
  const draw = interpolate(frame, [0, ms(fps, 250)], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const color = SCRIBBLE_COLOR[props.color] ?? kit.accent;
  // boil: a small deterministic wobble that changes every frame (chalk); otherwise fixed
  const j = (i: number) => { if (!props.boil) return 0; const x = Math.sin(g.seed * 12.9898 + i * 78.233 + frame * 37.719) * 43758.5453; return (x - Math.floor(x) - 0.5) * 6; };
  const stroke = {fill: 'none', stroke: color, strokeWidth: 5, strokeLinecap: 'round' as const, pathLength: 100, strokeDasharray: 100, strokeDashoffset: 100 * (1 - draw)};
  const cx = w / 2, cy = h / 2;
  const d =
    props.shape === 'underline' ? `M ${4 + j(0)},${cy + j(1)} Q ${cx + j(2)},${cy + 10 + j(3)} ${w - 4 + j(4)},${cy - 4 + j(5)}`
    : props.shape === 'wave' ? `M 4,${cy} ` + Array.from({length: 6}, (_, k) => `Q ${(w * (k + 0.5)) / 6 + j(k)},${cy + (k % 2 ? 1 : -1) * (h * 0.4) + j(k + 6)} ${(w * (k + 1)) / 6},${cy}`).join(' ')
    : '';
  return (
    <svg width={w} height={h} style={{overflow: 'visible', filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.35))'}}>
      {props.shape === 'ellipse' ? (
        <>
          <ellipse cx={cx + j(0)} cy={cy + j(1)} rx={cx - 6} ry={cy - 6} transform={`rotate(${-3 + j(2)} ${cx} ${cy})`} {...stroke} />
          <ellipse cx={cx + j(3)} cy={cy + 3 + j(4)} rx={cx - 10} ry={cy - 9} transform={`rotate(${4 + j(5)} ${cx} ${cy})`} {...stroke} strokeDashoffset={100 * Math.max(0, 1 - Math.max(0, draw - 0.15) / 0.85)} />
        </>
      ) : <path d={d} {...stroke} />}
    </svg>
  );
};

// Evo: a thin gradient rectangle that draws on in 11 frames and then keeps expanding until it leaves the frame
const OutlineRect: React.FC<{props: any; accent: string}> = ({props}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const kit = useBrand();
  const t = frame / fps;
  const draw = interpolate(frame, [0, ms(fps, 460)], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const inset = props.grow ? props.inset - (props.inset + 6) * Math.min(1, t / 2.0) : props.inset; // out of the frame by ~2 s
  const x = (1080 * inset) / 100, y = (1920 * inset) / 100;
  return (
    <svg width={1080} height={1920} style={{position: 'absolute', inset: 0, overflow: 'visible'}}>
      <defs><linearGradient id="outline-rect-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={kit.accent} /><stop offset="1" stopColor={kit.light} /></linearGradient></defs>
      <rect x={x} y={y} width={1080 - 2 * x} height={1920 - 2 * y} rx={28} fill="none" stroke="url(#outline-rect-g)" strokeWidth={3} pathLength={100} strokeDasharray={100} strokeDashoffset={100 * (1 - draw)} transform={`rotate(180 540 960)`} />
    </svg>
  );
};

// Prime: a glowing segment running around a rounded border inset from the edges, one lap per ~700 ms
const FrameLight: React.FC<{props: any; accent: string}> = ({props}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const kit = useBrand();
  const x = (1080 * props.inset) / 100, y = (1920 * props.inset) / 100;
  const lap = (frame / fps) / 0.7; // laps completed
  return (
    <svg width={1080} height={1920} style={{position: 'absolute', inset: 0, overflow: 'visible'}}>
      <rect x={x} y={y} width={1080 - 2 * x} height={1920 - 2 * y} rx={24} fill="none" stroke={kit.accent} strokeWidth={5} strokeLinecap="round" pathLength={100} strokeDasharray="12 88" strokeDashoffset={-((lap * 100) % 100)} style={{filter: `drop-shadow(0 0 6px ${kit.accent}) drop-shadow(0 0 18px ${kit.accent}aa)`, opacity: lap < props.laps ? 1 : 0}} />
    </svg>
  );
};


// César's CLEAN BLUE: Helvetica Bold (project font), white sentence-case line over a huge accent
// ALL-CAPS line. César 9:21: text effects carry NO drop shadow and solid #FFE500 (no gradient).
const CleanBlueTitle: React.FC<{props: any; accent: string}> = ({props, accent}) => {
  const fam = ensureProjectFont(PRESETS.vibem.font.custom!); // the same face and pins as vibem's captions: whichever loads it first
  const shadow = 'none';
  const stroke = {} as React.CSSProperties;
  const l2 = props.upper2 === false ? String(props.line2) : String(props.line2).toUpperCase();
  return (
    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1.04, fontFamily: fam, fontWeight: 700}}>
      <div style={{fontSize: fitSize(String(props.line1), 56, 'Inter', 900), color: '#fff', whiteSpace: 'nowrap', textShadow: shadow, letterSpacing: -0.5, ...stroke}}><Letters text={String(props.line1)} /></div>
      <div style={{fontSize: fitSize(l2, 150, 'Inter', 1030), color: accent, whiteSpace: 'nowrap', textShadow: shadow, letterSpacing: -1.5, ...stroke}}><Letters text={l2} /></div>
    </div>
  );
};

const COMPONENTS: Record<string, React.FC<{props: any; accent: string}>> = {ornament: Ornament, rules: Rules, 'person-outline': PersonOutlineStub, 'band-title': BandTitle, 'neon-frame': NeonFrame, scribble: Scribble, 'outline-rect': OutlineRect, 'frame-light': FrameLight, 'hook-stack': HookStack, 'label-2tone': Label2Tone, stat: Stat, chapter: Chapter, 'big-word': BigWord, 'clean-blue': CleanBlueTitle, 'kinetic-card': KineticCard, 'fill-title': FillTitle, 'script-title': ScriptTitle, oversized: Oversized, 'chapter-caps': ChapterCaps, starburst: Starburst, 'location-tag': LocationTag, price: Price, 'end-card': EndCard, sticker: Sticker};

export type Titles = {reveal: Reveal; out: Out}; // the caption pack's defaults for graphics that set neither

// block-level arrivals (src/motion.ts); letters / typewriter / shuffle / tracking work per character inside Letters
const BLOCK_IN: Partial<Record<Reveal, ArriveKind>> = {fade: 'fade', drop: 'drop', slideBlur: 'slideBlur', slideDown: 'slideDown', band: 'band', wipe: 'wipe'};
const BLOCK_OUT: Partial<Record<Out, LeaveKind>> = {auto: 'fade', fade: 'fade', cut: 'cut', blur: 'blur', slideUp: 'slideUp', band: 'slideDown'};

const One: React.FC<{g: Graphic; accent: string; durationInFrames: number; titles?: Titles}> = ({g, accent, durationInFrames, titles}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const Comp = COMPONENTS[g.template];
  const FONT = useFace('display').style.fontFamily;
  // templates get the accent for TEXT (a dark brand color lightened to read over
  // footage); fills (cards, bars, pins, bursts) take the exact kit color themselves
  accent = legible(accent);
  if (!Comp) return null;
  const reveal: Reveal = g.reveal && g.reveal !== 'auto' ? g.reveal : titles?.reveal ?? 'auto';
  const out: Out = g.out && g.out !== 'auto' ? g.out : titles?.out ?? 'auto';
  const framesLeft = durationInFrames - 1 - frame;
  const entry = BLOCK_IN[reveal] ? arrive(BLOCK_IN[reveal]!, frame, fps) : null;
  const exit = BLOCK_OUT[out] ? leave(BLOCK_OUT[out]!, framesLeft, fps) : {opacity: 1, blur: 0, dy: 0, letterCut: 0}; // letters: per character
  const life = lifeFx(g.life ?? 'none', frame, fps);
  const dx = (entry?.dx ?? 0) + life.dx, dy = (entry?.dy ?? 0) + exit.dy, scale = (entry?.scale ?? 1) * life.scale;
  const moving = dx !== 0 || dy !== 0 || scale !== 1 || life.rotate !== 0;
  const wrap: React.CSSProperties = {
    opacity: (entry?.opacity ?? 1) * exit.opacity,
    filter: (entry?.blur ?? 0) + exit.blur > 0.2 ? `blur(${((entry?.blur ?? 0) + exit.blur).toFixed(1)}px)` : undefined,
    clipPath: entry?.clip,
    pointerEvents: 'none',
  };
  const move = moving ? `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${scale.toFixed(3)}) rotate(${life.rotate.toFixed(2)}deg)` : '';
  const ctx: Gfx = {reveal, out, framesLeft, seed: seedOf(g.id), yPct: g.yPct ?? TEMPLATES[g.template].y};
  let node: React.ReactNode;
  if (FULL_FRAME.has(g.template) || DECOR_FULL.has(g.template)) {
    // covers the whole frame (a cutaway) or decorates it edge to edge: no text-block positioning
    node = (
      <div data-ab={`gfx:${g.id}`} style={{position: 'absolute', inset: 0, fontFamily: FONT, ...wrap, transform: move || undefined, transformOrigin: '50% 50%'}}>
        <Comp props={g.props} accent={accent} />
      </div>
    );
  } else if (CENTERED.has(g.template)) {
    // decor (sticker, starburst, frames, scribbles) is positioned by its center, not as a text block
    node = (
      <div data-ab={`gfx:${g.id}`} style={{position: 'absolute', top: `${g.yPct ?? TEMPLATES[g.template].y}%`, left: `${(g.props as any).xPct ?? 50}%`, transform: `translate(-50%, -50%) ${move}`, ...wrap}}>
        <Comp props={g.props} accent={accent} />
      </div>
    );
  } else {
    node = (
      <div data-ab={`gfx:${g.id}`} style={{position: 'absolute', top: `${g.yPct ?? TEMPLATES[g.template].y}%`, left: 0, right: 0, padding: '0 60px', textAlign: 'center', fontFamily: FONT, textShadow: SHADOW, ...wrap, transform: move || undefined, transformOrigin: '50% 50%'}}>
        <Comp props={g.props} accent={accent} />
      </div>
    );
  }
  return <GfxContext.Provider value={ctx}>{node}</GfxContext.Provider>;
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

const SHAPE_RADIUS: Record<string, string> = {rounded: '36px', arch: '50% 50% 28px 28px / 42% 42% 28px 28px', circle: '50%', phone: '64px', window: '10px', none: '0'};
const BORDER: Record<string, string> = {none: 'none', thin: '3px solid rgba(255,255,255,0.85)', glass: '1.5px solid rgba(255,255,255,0.35)', accent: '6px solid var(--accent)'};
const WINDOW_BAR = 44; // px, Mac OS classic title bar

// wraps the clip layer: canvas behind, the clips inside a shaped, inset frame. `footage` is the clip layer
// (hidden by a cutout layout so the canvas shows behind the cut-out presenter); `children` are the layers
// drawn over it inside the frame (behind-graphics, behind-captions, the person matte)
export const LayoutStage: React.FC<{items: Graphic[]; accentColor: string; footage: React.ReactNode; children: React.ReactNode}> = ({items, accentColor, footage, children}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const kit = useBrand();
  const active = useActiveLayout(items);
  if (!active) return <>{footage}{children}</>;
  const p: any = active.props;
  const {video} = layoutBoxes(p);
  const kind: LayoutIn = p.enter ?? 'frameIn';
  const startF = Math.round((active.startMs / 1000) * fps);
  const endF = Math.round((active.endMs / 1000) * fps);
  // a = 0 full-bleed → 1 framed; the entry eases per kind, the exit returns over its own frames
  const a = kind === 'slide' ? 1 : layoutIn(kind, frame - startF, fps) * layoutOut(kind, endF - 1 - frame, fps);
  const box = {top: video.top * a, left: video.left * a, width: 100 - (100 - video.width) * a, height: 100 - (100 - video.height) * a};
  // slide (Y2K): the framed video comes in from the right edge with trailing copies, and leaves the same way
  const slideIn = kind === 'slide' ? layoutIn('slide', frame - startF, fps) : 1;
  const slideOut = kind === 'slide' ? layoutOut('slide', endF - 1 - frame, fps) : 1;
  const dx = kind === 'slide' ? (1 - slideIn) * 120 + (1 - slideOut) * -120 : 0;
  const trail = kind === 'slide' ? windowTrail(frame - startF, fps, ms(fps, 420)) : {copies: []};
  const grid = p.canvas === 'grid';
  const canvas =
    p.canvas === 'dark' ? kit.dark
    : p.canvas === 'light' || grid ? kit.light
    : p.canvas === 'paper' ? '#F1E9D8'
    : p.canvas === 'gradient' ? `linear-gradient(160deg, ${accentColor} 0%, #ffffff 140%)`
    : accentColor;
  // cutout (Stack): the footage fades out over 2 f at the start and back over 4–5 f at the end; the canvas shows behind the matte
  const cut = p.cutout ? Math.min(interpolate(frame - startF, [0, 2], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}), interpolate(endF - 1 - frame, [0, 4], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})) : 0;
  const win = p.shape === 'window';
  const frameStyle: React.CSSProperties = {position: 'absolute', top: `${box.top}%`, left: `${box.left}%`, width: `${box.width}%`, height: `${box.height}%`, overflow: 'hidden', borderRadius: SHAPE_RADIUS[p.shape] ?? '0', border: win ? '2px solid #1c1c1c' : BORDER[p.border] ?? 'none', boxSizing: 'border-box', boxShadow: p.canvas === 'light' || grid ? '0 20px 60px rgba(0,0,0,0.18)' : '0 24px 70px rgba(0,0,0,0.45)', transform: dx ? `translateX(${dx.toFixed(1)}%)` : undefined};
  return (
    <div style={{position: 'absolute', inset: 0, background: canvas, ['--accent' as any]: accentColor, ...(grid ? {backgroundImage: `linear-gradient(rgba(0,0,0,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,0.08) 1px, transparent 1px)`, backgroundSize: '72px 72px'} : {})}}>
      {p.cutout ? <div style={{position: 'absolute', inset: 0, opacity: 1 - cut}}>{footage}</div> : null}
      {/* Y2K: the copies a dragged window leaves behind */}
      {trail.copies.map((c, i) => <div key={i} style={{...frameStyle, transform: `translate(${(dx + c.offset * 0.09).toFixed(1)}%, ${(c.offset * 0.05).toFixed(1)}%)`, background: '#d8d8d8', opacity: c.opacity, boxShadow: 'none'}} />)}
      <div style={frameStyle}>
        {win ? <div style={{position: 'absolute', top: 0, left: 0, right: 0, height: WINDOW_BAR, background: 'linear-gradient(#f4f4f4, #d9d9d9)', borderBottom: '2px solid #1c1c1c', zIndex: 2, display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 16}}>{['#ff5f57', '#febc2e', '#28c840'].map((c) => <div key={c} style={{width: 16, height: 16, borderRadius: '50%', background: c, border: '1px solid rgba(0,0,0,0.35)'}} />)}<div style={{marginLeft: 'auto', marginRight: 14, fontSize: 22, color: '#222'}}>▲</div></div> : null}
        <div style={{position: 'absolute', inset: win ? `${WINDOW_BAR}px 0 0 0` : 0}}>{p.cutout ? null : footage}{children}</div>
      </div>
    </div>
  );
};

// behind = only the graphics that go behind the presenter (rendered under the person matte)
export const GraphicsLayer: React.FC<{items: Graphic[]; accentColor: string; behind?: boolean; titles?: Titles}> = ({items, accentColor, behind = false, titles}) => {
  const {fps} = useVideoConfig();
  if (!items?.length) return null;
  return (
    <>
      {items.filter((g) => g.template !== 'layout' && !!g.behind === behind).map((g) => {
        const from = Math.round((g.startMs / 1000) * fps);
        const dur = Math.max(1, Math.round(((g.endMs - g.startMs) / 1000) * fps));
        return (
          <Sequence key={`${g.id}@${from}`} from={from} durationInFrames={dur} layout="none" name={`gfx ${g.template}`}>
            <One g={g} accent={accentColor} durationInFrames={dur} titles={titles} />
          </Sequence>
        );
      })}
    </>
  );
};
