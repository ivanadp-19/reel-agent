import React from 'react';
import {AbsoluteFill, Audio, OffthreadVideo, Video, Sequence, staticFile, useVideoConfig, useCurrentFrame, interpolate, getRemotionEnvironment} from 'remotion';
import {CaptionTrack} from './CaptionTrack';
import {BrollLayer, projectBrolls, type BrollItem} from './Broll';
import {focusSpans, hideUnder, projectCaptions, tierSpans, type Caption} from './captions';
import {presetOf} from './captionPresets';
import {packOf} from './stylePacks';
import {avoidGraphics} from './validate';
import {GraphicsLayer, LayoutStage} from './Graphics';
import {projectGraphics, type Graphic} from './graphicTemplates';
import {placeClips, totalDurationFrames, type Clip, type Music} from './timeline';
import {ClipMedia} from './ClipMedia';
import {PersonLayer, type Matte} from './Person';
import {BrandContext, resolveBrand, type Brand} from './brand';
import {registerClientFonts} from './fonts';
import {gradeFor, type ProjectGrade} from './grade';
import {COVER, DUR_MS, OVER, REVEALS, WHOOSH, coverShapes, overlapOf, seedOf, toneColor, type Enter} from './transitions';
import {ms as msToFrames} from './motion';

// Focus pull: the footage blurs (and grows a touch so the blurred edges stay off
// screen) while a tier-2 caption word or a B-roll card is up — Captions.ai
// Prism's signature. The same wrapper lands the reel's opening: a radial
// zoom-blur (or a plain blur-in) clearing over the first ~200 ms.
type Span = {startMs: number; endMs: number};
const JL_RAMP_FRAMES = 4; // J/L-cut audio fades over this many frames at its free edge
const smooth = (x: number) => x * x * (3 - 2 * x);
// 0→1 inside a span with ramps at both ends (ms)
const inSpans = (ms: number, spans: Span[], IN: number, OUT: number) => {
  let k = 0;
  for (const s of spans) {
    if (ms < s.startMs || ms > s.endMs) continue;
    k = Math.max(k, Math.min(1, Math.max(0, Math.min((ms - s.startMs) / IN, (s.endMs - ms) / OUT, 1))));
  }
  return smooth(k);
};
type Zoom = Span & {scale: number; inMs: number; outMs: number}; // a camera push that lives with a title (Orbit)
const FocusPull: React.FC<{spans: Span[]; blurPx: number; opening?: 'none' | 'zoomBlur' | 'blurIn'; punch?: {spans: Span[]; scale: number}; pulses?: Span[]; zooms?: Zoom[]; children: React.ReactNode}> = ({spans, blurPx, opening = 'none', punch, pulses = [], zooms = [], children}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const ms = (frame / fps) * 1000;
  const k = inSpans(ms, spans, 150, 240); // the blur is gone by the time the span ends (the next page lands sharp)
  const openF = msToFrames(fps, 210);
  const o = opening !== 'none' && frame < openF ? 1 - smooth(frame / openF) : 0; // 1 at the first frame, gone by ~200 ms
  const p = punch ? inSpans(ms, punch.spans, 125, 125) : 0; // Impact II: 1.12× in 3–4 f on the hero word
  const g = pulses.length ? inSpans(ms, pulses, 125, 125) : 0; // Impact II: a 250 ms blur + chromatic pulse
  let z = 0; // Orbit: 1.0 → 1.4× in 8 f from 3 f before the title, back over ~6 f when it leaves
  for (const zm of zooms) {
    if (ms < zm.startMs || ms > zm.endMs + zm.outMs) continue;
    const v = ms < zm.startMs + zm.inMs ? (ms - zm.startMs) / zm.inMs : ms <= zm.endMs ? 1 : 1 - (ms - zm.endMs) / zm.outMs;
    z = Math.max(z, zm.scale * smooth(Math.min(1, Math.max(0, v))));
  }
  const blur = Math.max(k * blurPx, o * 24, g * 14);
  const scale = 1 + 0.06 * k + (opening === 'zoomBlur' ? 0.1 * o : 0) + (punch?.scale ?? 0) * p + 0.04 * g + z;
  const split = g > 0.05 ? ` drop-shadow(${(6 * g).toFixed(1)}px 0 rgba(255,0,90,0.7)) drop-shadow(${(-6 * g).toFixed(1)}px 0 rgba(0,220,255,0.7))` : '';
  return <AbsoluteFill style={blur > 0.3 || scale > 1.001 ? {filter: `blur(${blur.toFixed(1)}px)${split}`, transform: `scale(${scale.toFixed(3)})`, transformOrigin: '50% 38%'} : undefined}>{children}</AbsoluteFill>;
};

// Cover transitions: shapes drawn over the cut (above footage and B-roll, below graphics and captions)
const TransitionOverlay: React.FC<{cuts: {frame: number; kind: Enter; seed: number}[]; accent: string}> = ({cuts, accent}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const shapes: React.ReactNode[] = [];
  for (const cut of cuts) {
    // a reveal kind's shapes run with its pre-roll (before the cut); the others sit centred on the cut
    const n = overlapOf(cut.kind, fps);
    const half = Math.max(1, Math.round((fps * (DUR_MS[cut.kind] ?? 250)) / 2000));
    const start = n ? cut.frame - n : cut.frame - half, len = n ? n : 2 * half;
    if (frame < start || frame >= start + len) continue;
    const t = (frame - start) / len;
    coverShapes(cut.kind, t, cut.seed).forEach((sh, i) => {
      if ((sh.opacity ?? 1) <= 0.005) return;
      shapes.push(<div key={`${cut.frame}-${i}`} style={{position: 'absolute', inset: 0, background: sh.gradient ?? toneColor(sh.tone, accent), clipPath: sh.clip, opacity: sh.opacity ?? 1, mixBlendMode: sh.screen ? 'screen' : undefined}} />);
    });
  }
  return shapes.length ? <AbsoluteFill style={{pointerEvents: 'none'}}>{shapes}</AbsoluteFill> : null;
};

// Music layer: start offset, volume, optional end fade-out, and optional
// auto-ducking — the music dips while someone is speaking (speech = caption spans).
const MusicTrack: React.FC<{music: NonNullable<Music>; totalFrames: number; speech: Array<[number, number]>}> = ({music, totalFrames, speech}) => {
  const {fps} = useVideoConfig();
  const fadeFrames = Math.round((music.fadeOutSec ?? 0) * fps);
  const DUCK_RAMP_MS = 250; // ease the dip in/out
  return (
    <Audio
      src={staticFile(music.src)}
      loop // a track shorter than the reel starts over (loops from Openverse are 30–60 s)
      trimBefore={Math.round((music.startSec ?? 0) * fps)}
      volume={(f) => {
        let v =
          fadeFrames > 0
            ? interpolate(f, [totalFrames - fadeFrames, totalFrames], [music.volume, 0], {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              })
            : music.volume;
        if (music.duck && speech.length) {
          const ms = (f / fps) * 1000;
          let dist = Infinity; // distance to the nearest speech span (0 = inside)
          for (const [a, b] of speech) {
            if (ms >= a && ms <= b) { dist = 0; break; }
            dist = Math.min(dist, ms < a ? a - ms : ms - b);
          }
          const k = Math.min(1, dist / DUCK_RAMP_MS); // 0 in speech → ducked, 1 far away
          const duckLevel = music.duckLevel ?? 0.25;
          v *= duckLevel + (1 - duckLevel) * k;
        }
        return v;
      }}
    />
  );
};

export const MultiClipVideo: React.FC<{
  clips?: Clip[];
  music?: Music;
  captions?: Caption[];
  captionStyle?: string;
  brolls?: BrollItem[];
  graphics?: Graphic[];
  mattes?: Matte[];
  accentColor?: string;
  brand?: Brand | null;
  grade?: ProjectGrade | null;
  audio?: {clean?: string; sfx?: boolean} | null;
  captionsOff?: boolean; // the project's captions switch (set_captions): pages are kept, none is drawn
}> = ({clips = [], music = null, captions: allCaptions = [], brolls = [], graphics = [], mattes = [], accentColor: projectAccent = '#FFB020', captionStyle, brand = null, grade = null, audio = null, captionsOff = false}) => {
  const captions = captionsOff ? [] : allCaptions; // the music still ducks under their words (speech spans below)
  const {fps} = useVideoConfig();
  const pack = packOf(captionStyle);
  const kit = resolveBrand(brand, projectAccent, pack);
  registerClientFonts(kit.fontFiles); // the client's own faces (public/fonts/), before any text asks for them
  const accentColor = kit.accent;
  const placed = placeClips(clips, fps);
  const totalFrames = totalDurationFrames(clips, fps);
  // captions + b-roll are anchored to clips (source-relative) → project to absolute
  const projectedCaptions = projectCaptions(captions, clips, fps);
  const projectedBrolls = projectBrolls(brolls, clips, fps);
  const projectedGraphics = projectGraphics(graphics, clips, fps);
  // captions step around text graphics, and none over a closing card (the voice goes on; the card carries the message)
  const shownCaptions = hideUnder(avoidGraphics(projectedCaptions, projectedGraphics, captionStyle), projectedGraphics.filter((g) => g.template === 'end-card'));
  const preset = presetOf(captionStyle);
  const focus = preset.focusPull ? focusSpans(shownCaptions, preset.holdMs) : [];
  // a B-roll card sits over blurred footage whatever the pack
  const cards = projectedBrolls.filter((b) => b.mode === 'card').map((b) => ({startMs: b.startMs, endMs: b.endMs}));
  const punch = preset.heroPunch ? {spans: tierSpans(shownCaptions, 2, preset.holdMs), scale: preset.heroPunch} : undefined;
  const pulses = preset.glitchPulse ? tierSpans(shownCaptions, 1, preset.holdMs, 250) : [];
  const zooms: Zoom[] = projectedGraphics.filter((g) => g.camera === 'punch').map((g) => ({startMs: g.startMs - 100, endMs: g.endMs, scale: 0.4, inMs: 333, outMs: 230}));
  // cover transitions on clips and on B-roll cues
  const cuts = [
    ...placed.filter(({clip}, i) => i > 0 && COVER.has(clip.enter as Enter)).map(({clip, fromFrame}) => ({frame: fromFrame, kind: clip.enter as Enter, seed: seedOf(clip.id)})),
    ...projectedBrolls.filter((b) => b.enter && COVER.has(b.enter)).map((b) => ({frame: Math.round((b.startMs / 1000) * fps), kind: b.enter as Enter, seed: seedOf(b.id)})),
  ];

  // OffthreadVideo is built for rendering (frame-accurate, but stutters/freezes
  // in the live Player). Use native <Video> in preview for smooth playback,
  // OffthreadVideo only when actually rendering the mp4.
  const Clip = getRemotionEnvironment().isRendering ? OffthreadVideo : Video;

  return (
    <BrandContext.Provider value={kit}>
    <AbsoluteFill style={{backgroundColor: 'black'}}>
      {/* clip layer — trimmed takes back-to-back, with keyframed zoom/pan; a
          layout graphic frames it over a canvas for its span */}
      <LayoutStage items={projectedGraphics} accentColor={accentColor} footage={
      <FocusPull spans={[...focus, ...cards]} blurPx={preset.focusPull || 18} opening={preset.opening} punch={punch} pulses={pulses} zooms={zooms}>
      {/* a clip entered with a reveal shows under the outgoing one: it starts its overlap early, drawn first, with its own incoming effect */}
      {placed.filter(({clip}) => REVEALS.has(clip.enter as Enter)).map(({clip, fromFrame}) => {
        const early = Math.min(overlapOf(clip.enter as Enter, fps), fromFrame, Math.round(clip.inSec * fps / (clip.speed ?? 1)));
        if (early <= 0) return null;
        const pre: Clip = {...clip, inSec: clip.inSec - (early / fps) * (clip.speed ?? 1), muted: true};
        return (
          <Sequence key={`${clip.id}-pre`} from={fromFrame - early} durationInFrames={early} layout="none" name={`${clip.id} (under the reveal)`}>
            <ClipMedia clip={pre} durFrames={early} Comp={Clip} grade={gradeFor(grade, clip.src)} accent={accentColor} transition={{clip: pre, offset: -early, durFrames: early + 1e6}} />
          </Sequence>
        );
      })}
      {placed.map(({clip, fromFrame, durFrames, jFrames}, i) => (
        <Sequence
          key={clip.id}
          from={fromFrame}
          durationInFrames={durFrames}
          // premount upcoming clips (hidden) so the <video> is decoded before the
          // cut — kills the black flash at segment seams in the preview
          premountFor={Math.round(fps)}
          name={clip.label ?? clip.id}
        >
          <ClipMedia clip={clip} durFrames={durFrames} Comp={Clip} grade={gradeFor(grade, clip.src)} accent={accentColor} transition={{clip, next: placed[i + 1]?.clip, offset: 0, durFrames}} jMuteFrames={jFrames} />
        </Sequence>
      ))}
      {/* J-cuts / L-cuts (audio only): a J-cut leads the clip's first j seconds
          of audio under the previous clip's tail (its own first frames are muted
          in ClipMedia so the lead flows through the cut); an L-cut trails the
          source audio past the video end, under the next clip's head. Both honor
          mute/volume; a muted clip has no J/L audio. The frames come from
          placeClips (same numbers ClipMedia mutes and set_audio_cut reports). */}
      {placed.map(({clip, fromFrame, durFrames, jFrames: jF, lFrames: lF}) => {
        const speed = clip.speed ?? 1;
        const vol = clip.muted ? 0 : clip.volume ?? 1;
        if (vol <= 0 || (jF <= 0 && lF <= 0)) return null;
        const inF = Math.round(clip.inSec * fps), outF = Math.round(clip.outSec * fps);
        // a short ramp on the edge that is not a seam: the lead fades in under the
        // previous clip, the trail fades out under the next (no click mid-word)
        const ramp = (k: number) => vol * Math.min(1, k / JL_RAMP_FRAMES);
        return (
          <React.Fragment key={`${clip.id}-jl`}>
            {jF > 0 ? (
              <Sequence from={fromFrame - jF} durationInFrames={jF} layout="none" name={`${clip.id} (J-cut lead)`}>
                <Audio src={staticFile(clip.src)} playbackRate={speed} trimBefore={inF} trimAfter={Math.round(inF + jF * speed)} volume={(f: number) => ramp(f + 1)} />
              </Sequence>
            ) : null}
            {lF > 0 ? (
              <Sequence from={fromFrame + durFrames} durationInFrames={lF} layout="none" name={`${clip.id} (L-cut trail)`}>
                <Audio src={staticFile(clip.src)} playbackRate={speed} trimBefore={outF} trimAfter={Math.round(outF + lF * speed)} volume={(f: number) => ramp(lF - f)} />
              </Sequence>
            ) : null}
          </React.Fragment>
        );
      })}
      {/* a cardDrop lands ON TOP of the outgoing clip: its pre-roll is drawn last */}
      {placed.filter(({clip}) => OVER.has(clip.enter as Enter)).map(({clip, fromFrame}) => {
        const early = Math.min(overlapOf(clip.enter as Enter, fps), fromFrame, Math.round(clip.inSec * fps / (clip.speed ?? 1)));
        if (early <= 0) return null;
        const pre: Clip = {...clip, inSec: clip.inSec - (early / fps) * (clip.speed ?? 1), muted: true};
        return (
          <Sequence key={`${clip.id}-over`} from={fromFrame - early} durationInFrames={early} layout="none" name={`${clip.id} (landing)`}>
            <ClipMedia clip={pre} durFrames={early} Comp={Clip} grade={gradeFor(grade, clip.src)} accent={accentColor} transition={{clip: pre, offset: -early, durFrames: early + 1e6}} />
          </Sequence>
        );
      })}
      </FocusPull>
      }>
      {/* graphics marked `behind` sit between the footage and the cut-out presenter */}
      <GraphicsLayer items={projectedGraphics} accentColor={accentColor} behind titles={preset.titles} />
      <CaptionTrack captions={shownCaptions} captionStyle={captionStyle} behind />
      <PersonLayer mattes={mattes} clips={clips} grade={grade} outlines={projectedGraphics.filter((g) => g.template === 'person-outline')} accent={accentColor} />
      </LayoutStage>

      {/* B-roll overlay (above clips, below captions); it blurs with the footage during a focus pull */}
      <FocusPull spans={focus} blurPx={preset.focusPull}>
        <BrollLayer items={projectedBrolls} layouts={projectedGraphics} defaults={pack ? {arrive: pack.brollIn, leave: pack.brollOut} : undefined} />
      </FocusPull>
      {/* cover transitions: flashes, bands, discs, mosaics… over the cut */}
      <TransitionOverlay cuts={cuts} accent={accentColor} />

      {/* motion graphics: headlines, labels, stats (in front of the presenter) */}
      <GraphicsLayer items={projectedGraphics} accentColor={accentColor} titles={preset.titles} />

      {/* music */}
      {music && <MusicTrack music={music} totalFrames={totalFrames} speech={projectCaptions(allCaptions, clips, fps).map((c) => [c.startMs, c.endMs])} />}

      {/* sound effects (synthesized, public/sfx): a whoosh on whip / zoom / card / split cuts, a pop on stickers */}
      {audio?.sfx ? [
        ...placed.filter(({clip}) => WHOOSH.has(clip.enter as Enter)).map(({clip, fromFrame}) => ({key: clip.id, from: fromFrame - (overlapOf(clip.enter as Enter, fps) || 3)})),
        ...projectedBrolls.filter((b) => b.enter && WHOOSH.has(b.enter)).map((b) => ({key: b.id, from: Math.round((b.startMs / 1000) * fps) - 3})),
      ].map(({key, from}) => (
        <Sequence key={`sfx-${key}`} from={Math.max(0, from)} durationInFrames={Math.round(fps * 0.6)} layout="none" name="sfx whoosh">
          <Audio src={staticFile('sfx/whoosh.wav')} volume={0.32} />
        </Sequence>
      )) : null}
      {audio?.sfx ? projectedGraphics.filter((g) => g.template === 'sticker' || g.template === 'starburst').map((g) => (
        <Sequence key={`sfx-${g.id}`} from={Math.round((g.startMs / 1000) * fps)} durationInFrames={Math.round(fps * 0.2)} layout="none" name="sfx pop">
          <Audio src={staticFile('sfx/pop.wav')} volume={0.4} />
        </Sequence>
      )) : null}

      {/* captions, always on top */}
      <CaptionTrack captions={shownCaptions} captionStyle={captionStyle} />
    </AbsoluteFill>
    </BrandContext.Provider>
  );
};
