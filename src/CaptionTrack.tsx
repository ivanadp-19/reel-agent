import React from 'react';
import {useCurrentFrame, useVideoConfig, interpolate, Sequence, spring, Easing} from 'remotion';
import {loadFont as loadInter} from '@remotion/google-fonts/Inter';
import {loadFont as loadMontserrat} from '@remotion/google-fonts/Montserrat';
import type {Caption, CaptionWord} from './captions';
import {presetOf, type Preset} from './captionPresets';

export type {Caption} from './captions';

// bundled OFL fonts: the export uses the same faces as the preview
const inter = loadInter('normal', {weights: ['400', '600', '800'], subsets: ['latin', 'latin-ext']});
const montserrat = loadMontserrat('normal', {weights: ['400', '600', '700', '800'], subsets: ['latin', 'latin-ext']});
const FAMILY: Record<Preset['font']['family'], string> = {Inter: inter.fontFamily, Montserrat: montserrat.fontFamily};
const ACCENT = '#FFB020';

// one word, styled by its tier; tier-2 words pop in at their own onset
const Word: React.FC<{w: CaptionWord; preset: Preset; accentColor: string; active: boolean; onsetFrame: number}> = ({w, preset, accentColor, active, onsetFrame}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const tier = (w.tier ?? 0) as 0 | 1 | 2;
  const t = tier ? preset.tiers[tier] : null;
  const emphasisPop = tier === 2 ? spring({frame: frame - onsetFrame, fps, config: {damping: 11, stiffness: 220, mass: 0.6}}) : 1;
  const scale = (t?.scale ?? 1) * (tier === 2 ? interpolate(emphasisPop, [0, 1], [0.7, 1]) : 1);
  const color = tier ? accentColor : preset.active === 'color' && !active ? preset.colors.dim : preset.colors.text;
  return (
    <span
      style={{
        display: 'inline-block',
        fontWeight: t?.weight ?? preset.font.weight,
        color,
        transform: scale === 1 ? undefined : `scale(${scale})`,
        transformOrigin: 'center 70%',
        whiteSpace: 'pre',
      }}
    >
      {w.text}
    </span>
  );
};

// one caption page inside its own Sequence
const CaptionPage: React.FC<{caption: Caption; preset: Preset; accentColor: string; durationInFrames: number}> = ({caption, preset, accentColor, durationInFrames}) => {
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

  return (
    <div
      style={{
        position: 'absolute',
        top: `${caption.topPct}%`,
        left: 0,
        right: 0,
        display: 'flex',
        justifyContent: 'center',
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
          justifyContent: 'center',
          flexWrap: 'wrap',
          gap: `0 ${Math.round(fontSize * 0.28)}px`,
          fontFamily: `${FAMILY[preset.font.family]}, system-ui, sans-serif`,
          fontSize,
          lineHeight: preset.font.lineHeight,
          letterSpacing: preset.font.trackingPx,
          textTransform: preset.font.case === 'upper' ? 'uppercase' : undefined,
          textShadow: preset.shadow || undefined,
          textAlign: 'center',
          ...(preset.box ? {background: preset.colors.box, borderRadius: Math.round(fontSize * 0.33), padding: `${Math.round(fontSize * 0.25)}px ${Math.round(fontSize * 0.5)}px`} : {}),
        }}
      >
        {caption.words.map((w, i) => (
          <Word
            key={i}
            w={w}
            preset={preset}
            accentColor={accentColor}
            active={absMs >= w.startMs && absMs <= w.endMs}
            onsetFrame={Math.round(((w.startMs - caption.startMs) / 1000) * fps)}
          />
        ))}
      </div>
    </div>
  );
};

// every page = its own Sequence; the page holds until the next one (max 700 ms, never past its clip)
export const CaptionTrack: React.FC<{captions: Caption[]; accentColor?: string; captionStyle?: string}> = ({captions, accentColor = ACCENT, captionStyle}) => {
  const {fps} = useVideoConfig();
  const preset = presetOf(captionStyle);
  if (!captions?.length) return null;
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
            <CaptionPage caption={c} preset={preset} accentColor={accentColor} durationInFrames={dur} />
          </Sequence>
        );
      })}
    </>
  );
};
