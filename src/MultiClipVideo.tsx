import React from 'react';
import {AbsoluteFill, Audio, OffthreadVideo, Video, Sequence, staticFile, useVideoConfig, useCurrentFrame, interpolate, getRemotionEnvironment} from 'remotion';
import {CaptionTrack} from './CaptionTrack';
import {BrollLayer, projectBrolls, type BrollItem} from './Broll';
import {focusSpans, hideUnder, projectCaptions, type Caption} from './captions';
import {presetOf} from './captionPresets';
import {avoidGraphics} from './validate';
import {GraphicsLayer, LayoutStage} from './Graphics';
import {projectGraphics, type Graphic} from './graphicTemplates';
import {placeClips, totalDurationFrames, type Clip, type Music} from './timeline';
import {ClipMedia} from './ClipMedia';
import {PersonLayer, type Matte} from './Person';
import {BrandContext, resolveBrand, type Brand} from './brand';
import {gradeFor, type ProjectGrade} from './grade';
import {OVERLAP, REVEALS, WHOOSH, type Enter} from './transitions';

// Focus pull: the footage blurs (and grows a touch so the blurred edges stay off
// screen) while a tier-2 caption word is up — Captions.ai Prism's signature.
const FocusPull: React.FC<{spans: {startMs: number; endMs: number}[]; blurPx: number; children: React.ReactNode}> = ({spans, blurPx, children}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const ms = (frame / fps) * 1000;
  const IN = 150, OUT = 240; // the blur is gone by the time the span ends (the next page lands sharp)
  let k = 0;
  for (const s of spans) {
    if (ms < s.startMs || ms > s.endMs) continue;
    const v = Math.min((ms - s.startMs) / IN, (s.endMs - ms) / OUT, 1);
    k = Math.max(k, Math.min(1, Math.max(0, v)));
  }
  k = k * k * (3 - 2 * k); // smoothstep
  return <AbsoluteFill style={k > 0.02 ? {filter: `blur(${(k * blurPx).toFixed(1)}px)`, transform: `scale(${(1 + 0.06 * k).toFixed(3)})`} : undefined}>{children}</AbsoluteFill>;
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
}> = ({clips = [], music = null, captions = [], brolls = [], graphics = [], mattes = [], accentColor: projectAccent = '#FFB020', captionStyle, brand = null, grade = null, audio = null}) => {
  const {fps} = useVideoConfig();
  const kit = resolveBrand(brand, projectAccent);
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

  // OffthreadVideo is built for rendering (frame-accurate, but stutters/freezes
  // in the live Player). Use native <Video> in preview for smooth playback,
  // OffthreadVideo only when actually rendering the mp4.
  const Clip = getRemotionEnvironment().isRendering ? OffthreadVideo : Video;

  return (
    <BrandContext.Provider value={kit}>
    <AbsoluteFill style={{backgroundColor: 'black'}}>
      {/* clip layer — trimmed takes back-to-back, with keyframed zoom/pan; a
          layout graphic frames it over a canvas for its span */}
      <LayoutStage items={projectedGraphics} accentColor={accentColor}>
      <FocusPull spans={focus} blurPx={preset.focusPull}>
      {/* a clip entered with a card / split reveal shows under the outgoing one: it starts OVERLAP frames early, drawn first */}
      {placed.filter(({clip}) => REVEALS.has(clip.enter as Enter)).map(({clip, fromFrame}) => {
        const early = Math.min(OVERLAP, fromFrame, Math.round(clip.inSec * fps / (clip.speed ?? 1)));
        if (early <= 0) return null;
        const pre: Clip = {...clip, inSec: clip.inSec - (early / fps) * (clip.speed ?? 1), enter: undefined, muted: true};
        return (
          <Sequence key={`${clip.id}-pre`} from={fromFrame - early} durationInFrames={early} layout="none" name={`${clip.id} (under the reveal)`}>
            <ClipMedia clip={pre} durFrames={early} Comp={Clip} grade={gradeFor(grade, clip.src)} />
          </Sequence>
        );
      })}
      {placed.map(({clip, fromFrame, durFrames}, i) => (
        <Sequence
          key={clip.id}
          from={fromFrame}
          durationInFrames={durFrames}
          // premount upcoming clips (hidden) so the <video> is decoded before the
          // cut — kills the black flash at segment seams in the preview
          premountFor={Math.round(fps)}
          name={clip.label ?? clip.id}
        >
          <ClipMedia clip={clip} durFrames={durFrames} Comp={Clip} grade={gradeFor(grade, clip.src)} transition={{clip, next: placed[i + 1]?.clip, offset: 0, durFrames}} />
        </Sequence>
      ))}
      </FocusPull>
      {/* graphics marked `behind` sit between the footage and the cut-out presenter */}
      <GraphicsLayer items={projectedGraphics} accentColor={accentColor} behind />
      <CaptionTrack captions={shownCaptions} captionStyle={captionStyle} behind />
      <PersonLayer mattes={mattes} clips={clips} grade={grade} />
      </LayoutStage>

      {/* B-roll overlay (above clips, below captions); it blurs with the footage during a focus pull */}
      <FocusPull spans={focus} blurPx={preset.focusPull}>
        <BrollLayer items={projectedBrolls} layouts={projectedGraphics} />
      </FocusPull>

      {/* motion graphics: headlines, labels, stats (in front of the presenter) */}
      <GraphicsLayer items={projectedGraphics} accentColor={accentColor} />

      {/* music */}
      {music && <MusicTrack music={music} totalFrames={totalFrames} speech={projectedCaptions.map((c) => [c.startMs, c.endMs])} />}

      {/* sound effects (synthesized, public/sfx): a whoosh on whip / zoom / card / split cuts, a pop on stickers */}
      {audio?.sfx ? [
        ...placed.filter(({clip}) => WHOOSH.has(clip.enter as Enter)).map(({clip, fromFrame}) => ({key: clip.id, from: fromFrame - (REVEALS.has(clip.enter as Enter) ? OVERLAP : 3)})),
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
