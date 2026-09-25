// Layered render: which caption pages the reel draws, what they do to the footage
// under them, and whether the captions can be rendered as their own transparent
// layer over a clean master (scripts/layers.mjs) or need the one-pass render.
//
// MultiClipVideo draws from captionLayout too, so the check and the picture are
// the same code: a caption effect that reaches into the footage shows up here
// as a blocker, and the render falls back to the full pass.
import {focusSpans, hideUnder, projectCaptions, tierSpans, type Caption} from './captions.ts';
import {presetOf} from './captionPresets.ts';
import {projectGraphics, type Graphic} from './graphicTemplates.ts';
import type {Clip} from './timeline.ts';
import {avoidGraphics} from './validate.ts';

type Span = {startMs: number; endMs: number};
export type LayerProps = {clips?: Clip[]; captions?: Caption[]; graphics?: Graphic[]; captionStyle?: string; captionsOff?: boolean};
// two ducking ramps (MultiClipVideo's MusicTrack eases 250 ms each way): in a shorter gap the music never gets fully back up
const SPEECH_GAP_MS = 500;

export function captionLayout({clips = [], captions = [], graphics = [], captionStyle, captionsOff = false}: LayerProps, fps: number) {
  const projectedGraphics = projectGraphics(graphics, clips, fps);
  // captions step around text graphics, and none over a closing card (the voice goes on; the card carries the message)
  const shownCaptions = captionsOff ? [] : hideUnder(avoidGraphics(projectCaptions(captions, clips, fps), projectedGraphics, captionStyle), projectedGraphics.filter((g) => g.template === 'end-card'));
  const preset = presetOf(captionStyle);
  const focus: Span[] = preset.focusPull ? focusSpans(shownCaptions, preset.holdMs) : [];
  const punch = preset.heroPunch ? {spans: tierSpans(shownCaptions, 2, preset.holdMs), scale: preset.heroPunch} : undefined;
  const pulses: Span[] = preset.glitchPulse ? tierSpans(shownCaptions, 1, preset.holdMs, 250) : [];
  // the music ducks under the spoken words, drawn or not (the captions switch keeps the speech), runs
  // closer than SPEECH_GAP_MS joined. How the words are paged is not in it: a moved page break keeps
  // the master of a layered render (scripts/layers.mjs keys the master on these spans)
  const speech: Array<[number, number]> = [];
  const said = captions.map((c) => (c.shiftMs ? {...c, shiftMs: 0} : c)); // where the words are said, not where a nudged page shows them
  for (const w of projectCaptions(said, clips, fps).flatMap((c) => c.words).sort((a, b) => a.startMs - b.startMs)) {
    const last = speech.at(-1);
    if (last && w.startMs - last[1] <= SPEECH_GAP_MS) last[1] = Math.max(last[1], w.endMs);
    else speech.push([w.startMs, w.endMs]);
  }
  return {preset, projectedGraphics, shownCaptions, focus, punch, pulses, speech};
}

export type RenderMode = 'full' | 'layers';

// Why these captions cannot be a separate layer over a caption-free master: each
// reason is something the one-pass render draws that an overlay cannot reproduce.
export function layerBlockers(props: LayerProps, fps: number): string[] {
  const {preset, shownCaptions, focus, punch, pulses} = captionLayout(props, fps);
  const out: string[] = [];
  if (shownCaptions.some((c) => c.behind)) out.push('captions behind the presenter (drawn under the person matte)');
  if (focus.length) out.push(`focus pull: the ${preset.id} pack blurs the footage under its tier-2 words`);
  if (punch?.spans.length) out.push(`hero punch: the ${preset.id} pack scales the footage on its tier-2 words`);
  if (pulses.length) out.push(`glitch pulse: the ${preset.id} pack blurs the footage on its tier-1 words`);
  if (shownCaptions.length && preset.container === 'glass') out.push(`glass pages: the ${preset.id} pack blurs the footage behind each page (backdrop blur)`);
  return out;
}

// The mode a render runs in: `layers` when asked and possible, `full` otherwise.
// No captions on screen needs no caption layer: the master is the reel (still cached).
export function chooseRenderMode(requested: RenderMode | undefined, props: LayerProps, fps: number): {mode: RenderMode; reasons: string[]; captions: boolean} {
  const captions = captionLayout(props, fps).shownCaptions.length > 0;
  if (requested !== 'layers') return {mode: 'full', reasons: [], captions};
  const reasons = layerBlockers(props, fps);
  return {mode: reasons.length ? 'full' : 'layers', reasons, captions};
}
