import React from 'react';
import {useCurrentFrame, useVideoConfig, interpolate, Sequence, spring, Easing} from 'remotion';
import type {Caption, CaptionWord} from './captions';
import {presetOf, type Preset, type TierStyle} from './captionPresets';
import {fontFamily} from './fonts';

export type {Caption} from './captions';

const FALLBACK_ACCENT = '#FFB020';

// one word, styled by its tier; in build mode it appears at its own onset
const Word: React.FC<{w: CaptionWord; preset: Preset; accent: string; active: boolean; onsetFrame: number}> = ({w, preset, accent, active, onsetFrame}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const tier = (w.tier ?? 0) as 0 | 1 | 2;
  const t: TierStyle = tier ? preset.tiers[tier] : {};
  const build = preset.reveal === 'build';
  const spoken = frame >= onsetFrame;
  // entrance at onset (build) — tier-2 words pop in either way
  const pops = build || tier === 2;
  const pop = pops ? spring({frame: frame - onsetFrame, fps, config: {damping: 12, stiffness: 220, mass: 0.6}}) : 1;
  const scale = (t.scale ?? 1) * (pops ? interpolate(pop, [0, 1], [0.7, 1]) : 1);
  const boxed = t.pill || t.block;
  const color = boxed
    ? preset.colors.onAccent ?? '#000'
    : tier && (t.color ?? 'accent') === 'accent'
      ? accent
      : preset.active === 'color' && !active
        ? preset.colors.dim
        : preset.colors.text;
  // not spoken yet: hidden (space reserved) or dimmed (karaoke)
  const opacity = build && !spoken ? (preset.upcoming === 'dim' ? 1 : 0) : 1;
  const dimmed = build && !spoken && preset.upcoming === 'dim';
  return (
    <span
      style={{
        display: 'inline-block',
        fontWeight: t.weight ?? preset.font.weight,
        fontStyle: t.italic || preset.font.italic ? 'italic' : undefined,
        fontFamily: t.font ? fontFamily(t.font) : undefined,
        color: dimmed ? preset.colors.dim : color,
        opacity,
        transform: scale === 1 ? undefined : `scale(${scale})`,
        transformOrigin: 'center 70%',
        whiteSpace: 'pre',
        ...(boxed && !dimmed
          ? {background: accent, padding: '0.02em 0.28em', borderRadius: t.pill ? '0.4em' : '0.12em', textShadow: 'none', margin: '0.06em 0'}
          : {}),
        ...(t.underline ? {borderBottom: `0.08em solid ${accent}`, paddingBottom: '0.02em'} : {}),
      }}
    >
      {w.text}
    </span>
  );
};

// floating positions cycle per page (Prism-style): top-left, top-right, low-center
const FLOAT = [
  {top: 12, align: 'flex-start'},
  {top: 15, align: 'flex-end'},
  {top: 66, align: 'center'},
] as const;

// one caption page inside its own Sequence
const CaptionPage: React.FC<{caption: Caption; index: number; preset: Preset; accent: string; durationInFrames: number}> = ({caption, index, preset, accent, durationInFrames}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const absMs = caption.startMs + (frame / fps) * 1000;
  const fontSize = Math.round(preset.font.sizePx * (caption.scale ?? 1));

  // entrance + exit. Guarded for very short pages (1–2 frames after autocut /
  // clip clamping): interpolate() needs strictly increasing ranges.
  const inF = Math.max(1, Math.min(Math.round((fps * preset.pageIn.ms) / 1000), Math.floor(durationInFrames / 2)));
  const outStart = Math.max(inF + 1, durationInFrames - Math.round((fps * preset.pageOut.ms) / 1000));
  const a = interpolate(frame, [0, inF], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic)});
  const disappear = outStart >= durationInFrames ? 1 : interpolate(frame, [outStart, durationInFrames], [1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
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
          ? {background: preset.colors.container ?? 'rgba(0,0,0,0.35)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)', border: '1px solid rgba(255,255,255,0.25)', borderRadius: Math.round(fontSize * 0.4), padding: `${Math.round(fontSize * 0.2)}px ${Math.round(fontSize * 0.45)}px`}
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
        opacity: a * disappear,
        transform: transform || undefined,
        filter: preset.pageIn.type === 'blur' ? `blur(${(1 - a) * 10}px)` : undefined,
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
          maxWidth: float ? '62%' : undefined,
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

// every page = its own Sequence; the page holds until the next one (max hold, never past its clip)
export const CaptionTrack: React.FC<{captions: Caption[]; accentColor?: string; captionStyle?: string}> = ({captions, accentColor, captionStyle}) => {
  const {fps} = useVideoConfig();
  const preset = presetOf(captionStyle);
  if (!captions?.length) return null;
  // the pack's own palette wins; otherwise the project's accent (brand kit comes later)
  const accent = preset.colors.accent ?? accentColor ?? FALLBACK_ACCENT;
  const hold = preset.layout.maxWords <= 1 ? 250 : 700; // word-at-a-time pages should not linger
  return (
    <>
      {captions.map((c, i) => {
        const nextStart = captions[i + 1]?.startMs ?? Infinity;
        const visEnd = Math.min(nextStart, c.endMs + hold, c.holdMaxMs ?? Infinity);
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
