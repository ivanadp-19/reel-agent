import React, {useLayoutEffect, useRef, useState} from 'react';
import {useCurrentFrame, useVideoConfig, interpolate, Sequence, spring, Easing} from 'remotion';
import type {Caption, CaptionWord} from './captions';
import {FLOAT_SLOTS as FLOAT, type Preset, type TierStyle} from './captionPresets';
import {captionPreset, fitPage} from './captionLayout';
import {arrive, boxTravel, leave, ms, type ArriveKind} from './motion';
import {emojiFamily, fontFamily, type FontFamily} from './fonts';
import {ensureProjectFont} from './projectFont';
import {legible, useBrand} from './brand';

export type {Caption} from './captions';

const CLAMP = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;

// one word, styled by its tier; in build mode it appears at its own onset
const Word: React.FC<{w: CaptionWord; index: number; preset: Preset; accent: string; active: boolean; underBox: boolean; onsetFrame: number; captionKeyIn?: ArriveKind}> = ({w, index, preset, accent, active, underBox, onsetFrame, captionKeyIn}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const tier = (w.tier ?? 0) as 0 | 1 | 2;
  const t: TierStyle = preset.tiers[tier] ?? {};
  const build = preset.reveal === 'build';
  const spoken = frame >= onsetFrame;
  // arrival (src/motion.ts): tier words use the pack's keyIn, plain words its wordIn (build only).
  // In build mode a word arrives at its own onset; in page mode everything arrives with the page.
  const kind: ArriveKind = tier ? (captionKeyIn ?? preset.keyIn) : build ? preset.wordIn : 'cut';
  const local = build ? frame - onsetFrame : frame;
  const m = arrive(kind, local, fps);
  // the tier's size is real layout (font-size) so the gap and the page box grow
  // with it; the transform only animates the arrival
  const moving = m.scale !== 1 || m.dx !== 0 || m.dy !== 0;
  const karaoke = preset.active === 'box-slide' || preset.active === 'box-jump'; // the page draws one travelling box; words never paint their own
  const boxed = !karaoke && !!(t.pill || t.block);
  const gradient = t.fill === 'gradient' && !!preset.colors.gradient && !boxed;
  // the ramp is 2.6× the word: each key word starts at a different stretch of it, like one gradient laid across the page (Prism)
  const phase = (index * 41) % 100;
  const color = boxed || underBox
    ? t.fg ?? preset.colors.onAccent ?? '#000'
    : tier && (t.color ?? 'accent') === 'accent'
      ? legible(accent) // accent as text; pills/blocks below keep the exact color
      : preset.active === 'color' && !active
        ? preset.colors.dim
        : preset.colors.text;
  // not spoken yet: hidden (space reserved) or dimmed (karaoke) — plain text either way
  const dimmed = build && !spoken && preset.upcoming === 'dim';
  const hidden = build && !spoken && (preset.upcoming === 'hidden' || preset.upcoming === 'collapse');
  const collapsed = build && !spoken && preset.upcoming === 'collapse'; // no space: the spoken group recenters live
  const opacity = hidden ? 0 : dimmed ? 1 : m.opacity;
  const styled = !dimmed && !hidden;
  // César 9:27: classifier highlights (keywords / questions / CTAs) get a more dynamic entry —
  // per-char rise (Remocn PerCharacterRise) + inline color sweep white -> #FFE500 (InlineHighlight)
  const hlRise = kind === 'highlightRise' && !dimmed && !hidden;
  // Apple-keynote kinetic type: word rises out of an overflow mask, soft blur settle, long ease-out
  const appleMask = kind === 'appleMask' && !dimmed && !hidden;
  const amT = appleMask ? interpolate(local, [0, ms(fps, 420)], [0, 1], {...CLAMP, easing: Easing.bezier(0.16, 1, 0.3, 1)}) : 1;
  const amOp = appleMask ? interpolate(local, [0, ms(fps, 140)], [0, 1], CLAMP) : 1;
  // Remocn TrackingIn: letter-spacing collapses from wide to normal with a spring snap
  const trackIn = kind === 'trackingIn' && !dimmed && !hidden;
  const trackSpring = trackIn ? spring({frame: local, fps, config: {damping: 14, stiffness: 180, mass: 0.7}}) : 1;
  const trackOp = trackIn ? interpolate(local, [0, ms(fps, 90)], [0, 1], CLAMP) : 1;
  // César 9:57: the sweep must FULLY finish before the page changes — complete by the word's own end
  // (min 120ms so ultra-short words still read as a sweep, capped at 240ms so it never lags)
  const wordDurF = Math.max(1, ((w.endMs - w.startMs) / 1000) * fps);
  const hlSweepEnd = Math.min(ms(fps, 240), Math.max(ms(fps, 120), wordDurF));
  const hlColorT = hlRise ? interpolate(local, [ms(fps, 60), hlSweepEnd], [0, 1], CLAMP) : 0;
  const hlAccent = 'rgba(255,229,0,0.85)'; // #FFE500 at the 85% letter opacity (César 9:37)
  const hlColor = hlRise ? (hlColorT >= 1 ? hlAccent : `color-mix(in srgb, ${hlAccent} ${Math.round(hlColorT * 100)}%, ${preset.colors.text})`) : undefined;
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
        data-w={index}
        style={{
          display: collapsed ? 'none' : 'inline-block',
          position: 'relative',
          zIndex: 1,
          fontWeight: t.weight ?? preset.font.weight,
          fontStyle: t.italic || preset.font.italic ? 'italic' : undefined,
          fontFamily: t.font ? fontFamily(t.font) : undefined,
          color: dimmed ? preset.colors.dim : gradient && styled ? 'transparent' : hlColor ?? color,
          opacity,
          fontSize: t.scale && t.scale !== 1 ? `${t.scale}em` : undefined,
          transform: moving ? `translate(${m.dx.toFixed(1)}px, ${m.dy.toFixed(1)}px) scale(${m.scale.toFixed(3)})` : undefined,
          ...(trackIn ? {letterSpacing: `${((1 - trackSpring) * 0.35).toFixed(3)}em`, opacity: trackOp} : {}),
          transformOrigin: 'center 70%',
          whiteSpace: 'pre',
          ...(preset.font.fauxStrokePx ? {WebkitTextStroke: `${preset.font.fauxStrokePx}px currentColor`, paintOrder: 'stroke'} : {}),
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
        {appleMask
          ? <span style={{display: 'inline-block', overflow: 'hidden', verticalAlign: 'bottom'}}><span style={{display: 'inline-block', transform: `translateY(${((1 - amT) * 110).toFixed(1)}%)`, opacity: amOp, filter: amT < 0.999 ? `blur(${((1 - amT) * 5).toFixed(1)}px)` : undefined}}>{w.text}</span></span>
          : hlRise
          ? w.text.split('').map((ch, ci) => {
              const cl = local - ci * ms(fps, 16); // César 9:57: faster entry
              const ct = interpolate(cl, [0, ms(fps, 110)], [0, 1], {...CLAMP, easing: Easing.out(Easing.cubic)});
              const co = interpolate(cl, [0, ms(fps, 45)], [0, 1], CLAMP);
              const cb = (1 - ct) * 6; // motion blur while the char rises
              return <span key={ci} style={{display: 'inline-block', transform: `translateY(${((1 - ct) * 0.55).toFixed(3)}em)`, opacity: co, filter: cb > 0.2 ? `blur(${cb.toFixed(1)}px)` : undefined}}>{ch}</span>;
            })
          : w.text}
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
  // Bonded pairs (layout.unbreakable) render inside a nowrap span so flex-wrap can never
  // split a name ('MONTEALBÁN 326'); the page shrinks so the widest unbreakable unit fits
  // the frame (César 10:35: "3 lines or a smaller size beat splitting a name"). Both come
  // from src/captionLayout.ts, measured as rendered (case, tier scale) — the render judge
  // reads the same function.
  const {width: compWidth} = useVideoConfig();
  const float0 = preset.position === 'float' && !caption.pin;
  const {paired, fontSize} = fitPage(caption, preset, {compWidth, float: float0});

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

  // karaoke box (Focus slides it, Lift/Stack jump it): one box behind the last
  // spoken word. Word boxes come from the DOM (offset*, which ignores the
  // arrival transforms) — no layout is re-implemented here. Measured after
  // every render but stored only when they change, so the one re-render
  // happens when the web font lands and the lines re-wrap.
  const karaoke = preset.active === 'box-slide' || preset.active === 'box-jump';
  const host = useRef<HTMLDivElement>(null);
  const [rects, setRects] = useState<string>(''); // JSON of the boxes: a string compares for free
  useLayoutEffect(() => {
    if (!karaoke || !host.current) return;
    const next = JSON.stringify(Array.from(host.current.querySelectorAll<HTMLElement>('[data-w]')).map((el) => [el.offsetLeft, el.offsetTop, el.offsetWidth, el.offsetHeight]));
    if (next !== rects) setRects(next);
  });
  const boxes: number[][] = rects ? JSON.parse(rects) : [];
  const onset = (i: number) =>
    preset.fastBuildMs != null
      ? Math.round(((i * preset.fastBuildMs) / 1000) * fps)
      : Math.round(((caption.words[i].startMs - caption.startMs) / 1000) * fps);
  let spokenIdx = -1;
  caption.words.forEach((w, i) => { if (frame >= onset(i)) spokenIdx = i; });
  const lastEndMs = spokenIdx >= 0 ? caption.words[spokenIdx].endMs : 0;
  const boxOff = spokenIdx >= 0 && spokenIdx === caption.words.length - 1 && absMs > lastEndMs + 300; // Lift: switches off ~0.3 s after the last word
  const boxTier = spokenIdx >= 0 ? ((caption.words[spokenIdx].tier ?? 0) as 0 | 1 | 2) : 0;
  const boxStyle: TierStyle = boxTier ? preset.tiers[boxTier] ?? {} : {};
  let box: React.CSSProperties | null = null;
  if (karaoke && spokenIdx >= 0 && boxes[spokenIdx]) {
    const R = (b: number[]) => ({left: b[0], top: b[1], width: b[2], height: b[3]});
    const cur = R(boxes[spokenIdx]);
    const prev = preset.active === 'box-slide' && spokenIdx > 0 ? R(boxes[spokenIdx - 1]) : cur;
    const local = frame - onset(spokenIdx);
    const at = (a: number, b: number) => boxTravel(a, b, local, fps);
    const padX = fontSize * 0.28, padY = fontSize * 0.02;
    const fadeIn = preset.active === 'box-jump' ? interpolate(local, [0, ms(fps, 80)], [0, 1], CLAMP) : 1;
    const rounded = preset.tiers[1]?.block ? fontSize * 0.1 : fontSize * 0.35;
    box = {
      position: 'absolute', zIndex: 0,
      left: at(prev.left, cur.left) - padX, top: at(prev.top, cur.top) - padY,
      width: at(prev.width, cur.width) + 2 * padX, height: at(prev.height, cur.height) + 2 * padY,
      background: boxStyle.bg ?? accent, borderRadius: rounded,
      opacity: boxOff ? 0 : fadeIn,
    };
  }
  const containerStyle: React.CSSProperties =
    preset.container === 'pill'
      ? {background: preset.colors.container ?? 'rgba(0,0,0,0.72)', borderRadius: Math.round(fontSize * 0.5), padding: `${Math.round(fontSize * 0.22)}px ${Math.round(fontSize * 0.5)}px`}
      : preset.container === 'bar'
        ? {background: preset.colors.container ?? '#000', borderRadius: 4, padding: `${Math.round(fontSize * 0.12)}px ${Math.round(fontSize * 0.3)}px`}
        : preset.container === 'comic'
        ? {background: preset.colors.container ?? '#ffffff', border: '3px solid #111', boxShadow: '6px 8px 0 #111', borderRadius: Math.round(fontSize * 0.6), padding: `${Math.round(fontSize * 0.18)}px ${Math.round(fontSize * 0.5)}px`}
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
        filter: [(preset.pageIn.type === 'blur' || preset.pageIn.type === 'slideUp') && a < 1 ? `blur(${((1 - a) * (preset.pageIn.type === 'blur' ? 10 : 6)).toFixed(1)}px)` : '', ex.blur > 0.2 ? `blur(${ex.blur.toFixed(1)}px)` : ''].filter(Boolean).join(' ') || undefined,
      }}
    >
      <div
        ref={host}
        data-ab={`cap:${caption.id}`}
        style={{
          position: 'relative',
          display: 'flex',
          justifyContent: float ? float.align : 'center',
          flexWrap: 'wrap',
          alignItems: 'baseline',
          gap: `0 ${Math.round(fontSize * (preset.font.wordGapEm ?? 0.26))}px`,
          maxWidth: float ? '68%' : undefined,
          fontFamily: preset.font.custom ? ensureProjectFont(preset.font.custom) : fontFamily(preset.font.family as FontFamily),
          fontSize,
          lineHeight: preset.font.lineHeight,
          letterSpacing: preset.font.trackingPx,
          textTransform: preset.font.case === 'upper' ? 'uppercase' : undefined,
          textShadow: preset.shadow || undefined,
          textAlign: float && float.align !== 'center' ? (float.align === 'flex-start' ? 'left' : 'right') : 'center',
          ...containerStyle,
        }}
      >
        {box ? <div style={box} /> : null}
  {(() => {
        // César 10:35: a development name like 'Montealbán 326' must never split across lines.
        // v10.2 exact-pair nowrap: bonded pairs (Capitalized + Capitalized/digit, name+number
        // first, never chained — bondedPairs in src/captionLayout.ts) render inside a nowrap
        // group so flex-wrap can never separate them, whatever the measured widths say.
        const gapPx = Math.round(fontSize * (preset.font.wordGapEm ?? 0.26));
        const els: React.ReactNode[] = [];
        const wordEl = (i: number) => {
          const w = caption.words[i];
          return (
            <Word
              key={i}
              w={w}
              index={i}
              preset={preset}
              accent={accent}
              active={absMs >= w.startMs && absMs <= w.endMs}
              underBox={!!box && i === spokenIdx && !boxOff}
              onsetFrame={onset(i)}
              captionKeyIn={caption.keyIn}
            />
          );
        };
        for (let i = 0; i < caption.words.length; i++) {
          const w = caption.words[i];
          if (w.br) els.push(<div key={`br${i}`} style={{flexBasis: '100%', height: 0}} />);
          if (paired.has(i)) {
            els.push(
              <span key={`g${i}`} style={{display: 'inline-flex', whiteSpace: 'nowrap', gap: `0 ${gapPx}px`, alignItems: 'baseline'}}>
                {wordEl(i)}{wordEl(i + 1)}
              </span>
            );
            i++;
          } else {
            els.push(wordEl(i));
          }
        }
        return els;
      })()}
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
  // a brand kit overrides the pack's accent and (when it names one) its font on sans packs
  // (src/captionLayout.ts). Without a kit the pack's own palette wins over the project accent
  const preset = captionPreset(captionStyle, kit.body); // may be a client font: fontFamily() resolves both
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
