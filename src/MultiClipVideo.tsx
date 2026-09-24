import React from 'react';
import {AbsoluteFill, Audio, OffthreadVideo, Video, Sequence, staticFile, useVideoConfig, useCurrentFrame, interpolate, getRemotionEnvironment} from 'remotion';
import {CaptionTrack} from './CaptionTrack';
import {BrollLayer, projectBrolls, type BrollItem} from './Broll';
import {hideUnder, projectCaptions, type Caption} from './captions';
import {GraphicsLayer, LayoutStage} from './Graphics';
import {projectGraphics, type Graphic} from './graphicTemplates';
import {placeClips, totalDurationFrames, type Clip, type Music} from './timeline';
import {ClipMedia} from './ClipMedia';
import {PersonLayer, type Matte} from './Person';
import {BrandContext, resolveBrand, type Brand} from './brand';
import {gradeFor, type ProjectGrade} from './grade';

// Music layer: start offset, volume, optional end fade-out, and optional
// auto-ducking — the music dips while someone is speaking (speech = caption spans).
const MusicTrack: React.FC<{music: NonNullable<Music>; totalFrames: number; speech: Array<[number, number]>}> = ({music, totalFrames, speech}) => {
  const {fps} = useVideoConfig();
  const fadeFrames = Math.round((music.fadeOutSec ?? 0) * fps);
  const DUCK_RAMP_MS = 250; // ease the dip in/out
  return (
    <Audio
      src={staticFile(music.src)}
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
}> = ({clips = [], music = null, captions = [], brolls = [], graphics = [], mattes = [], accentColor: projectAccent = '#FFB020', captionStyle, brand = null, grade = null}) => {
  const {fps} = useVideoConfig();
  const kit = resolveBrand(brand, projectAccent);
  const accentColor = kit.accent;
  const placed = placeClips(clips, fps);
  const totalFrames = totalDurationFrames(clips, fps);
  // captions + b-roll are anchored to clips (source-relative) → project to absolute
  const projectedCaptions = projectCaptions(captions, clips, fps);
  const projectedBrolls = projectBrolls(brolls, clips, fps);
  const projectedGraphics = projectGraphics(graphics, clips, fps);
  // no captions over a closing card (the voice goes on; the card carries the message)
  const shownCaptions = hideUnder(projectedCaptions, projectedGraphics.filter((g) => g.template === 'end-card'));

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
      {/* graphics marked `behind` sit between the footage and the cut-out presenter */}
      <GraphicsLayer items={projectedGraphics} accentColor={accentColor} behind />
      <CaptionTrack captions={shownCaptions} captionStyle={captionStyle} behind />
      <PersonLayer mattes={mattes} clips={clips} grade={grade} />
      </LayoutStage>

      {/* B-roll overlay (above clips, below captions) */}
      <BrollLayer items={projectedBrolls} layouts={projectedGraphics} />

      {/* motion graphics: headlines, labels, stats (in front of the presenter) */}
      <GraphicsLayer items={projectedGraphics} accentColor={accentColor} />

      {/* music */}
      {music && <MusicTrack music={music} totalFrames={totalFrames} speech={projectedCaptions.map((c) => [c.startMs, c.endMs])} />}

      {/* captions, always on top */}
      <CaptionTrack captions={shownCaptions} captionStyle={captionStyle} />
    </AbsoluteFill>
    </BrandContext.Provider>
  );
};
