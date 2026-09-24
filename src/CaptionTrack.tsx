import React from 'react';
import {useCurrentFrame, useVideoConfig, interpolate, Sequence, spring, Easing} from 'remotion';
import type {Caption, CaptionWord} from './captions';
import {FLOAT_SLOTS as FLOAT, pageScale, presetOf, type Preset, type TierStyle} from './captionPresets';
import {arrive, leave, type ArriveKind} from './motion';
import {emojiFamily, fontFamily} from './fonts';
import {legible, useBrand} from './brand';

export type {Caption} from './captions';

const CLAMP = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
const SANS = new Set<string>(['Inter', 'Montserrat', 'Poppins']);

// one word, styled by its tier; in build mode it appears at its own onset
const Word: React.FC<{w: CaptionWord; index: number; preset: Preset; accent: string; active: boolean; onsetFrame: number}> = ({w, index, preset, accent, active, onsetFrame}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const tier = (w.tier ?? 0) as 0 | 1 | 2;
  const t: TierStyle = preset.tiers[tier] ?? {};
  const build = preset.reveal === 'build';
  const spoken = frame >= onsetFrame;
  // arrival (src/motion.ts): tier words use the pack's keyIn, plain words its wordIn (build only).
  // In build mode a word arrives at its own onset; in page mode everything arrives with the page.
  const kind: ArriveKind = tier ? preset.keyIn : build ? preset.wordIn : 'cut';
  const local = build ? frame - onsetFrame : frame;
  const m = arrive(kind, local, fps);
  // the tier's size is real layout (font-size) so the gap and the page box grow
  // with it; the transform only animates the arrival
  const moving = m.scale !== 1 || m.dx !== 0 || m.dy !== 0;
  const boxed = !!(t.pill || t.block);
  const gradient = t.fill === 'gradient' && !!preset.colors.gradient && !boxed;
  // the ramp is 2.6× the word: each key word starts at a different stretch of it, like one gradient laid across the page (Prism)
  const phase = (index * 41) % 100;
  const color = boxed
    ? t.fg ?? preset.colors.onAccent ?? '#000'
    : tier && (t.color ?? 'accent') === 'accent'
      ? legible(accent) // accent as text; pills/blocks below keep the exact color
      : preset.active === 'color' && !active
        ? preset.colors.dim
        : preset.colors.text;
  // not spoken yet: hidden (space reserved) or dimmed (karaoke) — plain text either way
  const dimmed = build && !spoken && preset.upcoming === 'dim';
  const hidden = build && !spoken && preset.upcoming === 'hidden';
  const opacity = hidden ? 0 : dimmed ? 1 : m.opacity;
  const styled = !dimmed && !hidden;
  // the word's emoji pops in at the word's onset, as its own item beside it
  const ePop = w.emoji ? spring({frame: build ? frame - onsetFrame : frame, fps, config: {damping: 10, stiffness: 200, mass: 0.6}}) : 0;
  const glow = t.glow && styled ? `0 0 0.2em ${accent}, 0 0 0.6em ${accent}99, ${preset.shadow || '0 2px 10px rgba(0,0,0,0.5)'}` : undefined;
  // chromatic split while an `rgb` arrival settles (Impact II)
  const split = m.rgb > 0.3 ? `${m.rgb.toFixed(1)}px 0 rgba(255,0,90,0.8), ${(-m.rgb).toFixed(1)}px 0 rgba(0,220,255,0.8)` : undefined;
  // a light band that sweeps the key word left→right while it arrives (Prism's shine)
  const SHINE = 'linear-gradient(100deg, rgba(255,255,255,0) 35%, rgba(255,255,255,0.9) 50%, rgba(255,255,255,0) 65%)';
  const layers = gradient && styled
    ? {backgroundImage: `${SHINE}, ${preset.colors.gradient}`, backgroundSize: '300% 100%, 260% 100%', backgroundPosition: `${((1 - m.shine) * 100).toFixed(1)}% 0, ${phase}% 0`, backgroundRepeat: 'no-repeat'}
    : null;
  const filters = [m.blur > 0.2 ? `blur(${m.blur.toFixed(1)}px)` : '', gradient && styled ? 'drop-shadow(0 3px 6px rgba(0,0,0,0.5))' : ''].filter(Boolean).join(' ');
  return (
    <>
      <span
        style={{
          display: 'inline-block',
          fontWeight: t.weight ?? preset.font.weight,
          fontStyle: t.italic || preset.font.italic ? 'italic' : undefined,
          fontFamily: t.font ? fontFamily(t.font) : undefined,
          color: dimmed ? preset.colors.dim : gradient && styled ? 'transparent' : color,
          opacity,
          fontSize: t.scale && t.scale !== 1 ? `${t.scale}em` : undefined,
          transform: moving ? `translate(${m.dx.toFixed(1)}px, ${m.dy.toFixed(1)}px) scale(${m.scale.toFixed(3)})` : undefined,
          transformOrigin: 'center 70%',
          whiteSpace: 'pre',
          filter: filters || undefined,
          ...(layers
            // background-clip text: a text-shadow would paint over the gradient, so the shadow is the drop-shadow filter above
            ? {...layers, WebkitBackgroundClip: 'text', backgroundClip: 'text', textShadow: 'none'}
            : {}),
          ...(glow ? {textShadow: glow} : {}),
          ...(split ? {textShadow: split} : {}),
          ...(boxed && styled
            ? {background: t.bg ?? accent, padding: '0.02em 0.28em', borderRadius: t.pill ? '0.35em' : '0.1em', textShadow: 'none', margin: '0.06em 0'}
            : {}),
          ...(t.underline && styled ? {borderBottom: `0.08em solid ${accent}`, paddingBottom: '0.02em'} : {}),
        }}
      >
        {w.text}
      </span>
      {w.emoji ? <span style={{display: 'inline-block', fontFamily: emojiFamily(), fontStyle: 'normal', textShadow: 'none', opacity: Math.min(1, ePop * 1.5), transform: `scale(${interpolate(ePop, [0, 1], [0.2, 1])}) rotate(${interpolate(ePop, [0, 1], [-25, 0])}deg)`}}>{w.emoji}</span> : null}
    </>
  );
};

// floating positions: FLOAT_SLOTS in captionPresets.ts (shared with validate.ts)
// one caption page inside its own Sequence
const CaptionPage: React.FC<{caption: Caption; index: number; preset: Preset; accent: string; durationInFrames: number}> = ({caption, index, preset, accent, durationInFrames}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const absMs = caption.startMs + (frame / fps) * 1000;
  const fontSize = Math.round(preset.font.sizePx * (caption.scale ?? 1) * pageScale(preset, caption.words.length));

  // entrance + exit. Guarded for very short pages (1–2 frames after autocut /
  // clip clamping): interpolate() needs strictly increasing ranges.
  const inF = Math.max(1, Math.min(Math.round((fps * preset.pageIn.ms) / 1000), Math.floor(durationInFrames / 2)));
  const a = interpolate(frame, [0, inF], [0, 1], {...CLAMP, easing: Easing.out(Easing.cubic)});
  const ex = leave(preset.pageOut, durationInFrames - 1 - frame, fps); // cut = opaque until the last frame
  const pop = preset.pageIn.type === 'pop' ? spring({frame, fps, config: {damping: 12, stiffness: 210, mass: 0.6}}) : 1;
  const transform = [
    preset.pageIn.type === 'slideUp' ? `translateY(${(1 - a) * 14}px)` : '',
    preset.pageIn.type === 'pop' ? `scale(${interpolate(pop, [0, 1], [0.85, 1])})` : '',
  ].filter(Boolean).join(' ');

  const float = preset.position === 'float' && !caption.pin ? FLOAT[index % FLOAT.length] : null;
  const containerStyle: React.CSSProperties =
    preset.container === 'pill'
      ? {background: preset.colors.container ?? 'rgba(0,0,0,0.72)', borderRadius: Math.round(fontSize * 0.5), padding: `${Math.round(fontSize * 0.22)}px ${Math.round(fontSize * 0.5)}px`}
      : preset.container === 'bar'
        ? {background: preset.colors.container ?? '#000', borderRadius: 4, padding: `${Math.round(fontSize * 0.12)}px ${Math.round(fontSize * 0.3)}px`}
        : preset.container === 'glass'
          ? {background: preset.colors.container ?? 'rgba(255,255,255,0.16)', backdropFilter: 'blur(22px)', WebkitBackdropFilter: 'blur(22px)', border: '1.5px solid rgba(255,255,255,0.32)', boxShadow: '0 10px 40px rgba(0,0,0,0.25)', borderRadius: Math.round(fontSize * 0.45), padding: `${Math.round(fontSize * 0.28)}px ${Math.round(fontSize * 0.5)}px`}
          : {};

  return (
    <div
      style={{
        position: 'absolute',
        top: `${float ? float.top : caption.topPct}%`,
        left: 0,
        right: 0,
        display: 'flex',
        justifyContent: float ? float.align : 'center',
        padding: '0 70px',
        opacity: a * ex.opacity,
        transform: [transform, ex.dy ? `translateY(${ex.dy.toFixed(1)}px)` : ''].filter(Boolean).join(' ') || undefined,
        filter: [preset.pageIn.type === 'blur' && a < 1 ? `blur(${((1 - a) * 10).toFixed(1)}px)` : '', ex.blur > 0.2 ? `blur(${ex.blur.toFixed(1)}px)` : ''].filter(Boolean).join(' ') || undefined,
      }}
    >
      <div
        data-ab={`cap:${caption.id}`}
        style={{
          display: 'flex',
          justifyContent: float ? float.align : 'center',
          flexWrap: 'wrap',
          alignItems: 'baseline',
          gap: `0 ${Math.round(fontSize * 0.26)}px`,
          maxWidth: float ? '68%' : undefined,
          fontFamily: fontFamily(preset.font.family),
          fontSize,
          lineHeight: preset.font.lineHeight,
          letterSpacing: preset.font.trackingPx,
          textTransform: preset.font.case === 'upper' ? 'uppercase' : undefined,
          textShadow: preset.shadow || undefined,
          textAlign: float && float.align !== 'center' ? (float.align === 'flex-start' ? 'left' : 'right') : 'center',
          ...containerStyle,
        }}
      >
        {caption.words.map((w, i) => (
          <Word
            key={i}
            w={w}
            index={i}
            preset={preset}
            accent={accent}
            active={absMs >= w.startMs && absMs <= w.endMs}
            onsetFrame={Math.round(((w.startMs - caption.startMs) / 1000) * fps)}
          />
        ))}
      </div>
    </div>
  );
};

// every page = its own Sequence; the page holds until the next one (max hold, never past its clip).
// Rendered twice: behind=true draws only the pages marked behind (under the
// presenter's matte), the default draws the rest on top. Timing and float
// positions come from the full list either way.
export const CaptionTrack: React.FC<{captions: Caption[]; captionStyle?: string; behind?: boolean}> = ({captions, captionStyle, behind = false}) => {
  const {fps} = useVideoConfig();
  const kit = useBrand();
  const base = presetOf(captionStyle);
  // a brand kit overrides the pack's accent and (when it names one) its font —
  // but only on sans packs: a pack whose identity is its face (condensed,
  // serif, script) keeps it. Without a kit the pack's own palette wins over the project accent
  const preset = kit.body && SANS.has(base.font.family) ? {...base, font: {...base.font, family: kit.body}} : base;
  if (!captions?.length) return null;
  const accent = kit.branded ? kit.accent : (preset.colors.accent ?? kit.accent);
  return (
    <>
      {captions.map((c, i) => {
        if (!!c.behind !== behind) return null;
        const nextStart = captions[i + 1]?.startMs ?? Infinity;
        const visEnd = Math.min(nextStart, c.endMs + preset.holdMs, c.holdMaxMs ?? Infinity);
        const from = Math.round((c.startMs / 1000) * fps);
        const dur = Math.max(1, Math.round(((visEnd - c.startMs) / 1000) * fps));
        return (
          <Sequence key={`${c.id}@${from}`} from={from} durationInFrames={dur} layout="none" name={c.words.map((w) => w.text).join(' ')}>
            <CaptionPage caption={c} index={i} preset={preset} accent={accent} durationInFrames={dur} />
          </Sequence>
        );
      })}
    </>
  );
};
