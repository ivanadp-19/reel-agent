// Layered render: which caption pages the reel draws, what they do to the footage
// under them, and whether the captions can be rendered as their own transparent
// layer over a clean master (scripts/layers.mjs) or need the one-pass render.
//
// MultiClipVideo draws from captionLayout too, so the check and the picture are
// the same code: a caption effect that reaches into the footage shows up here
// as a blocker, and the render falls back to the full pass.
import {focusSpans, hideUnder, projectCaptions, tierSpans, type Caption} from './captions.ts';
import {presetOf} from './captionPresets.ts';
import {isTextGraphic, projectGraphics, type Graphic} from './graphicTemplates.ts';
import type {Clip} from './timeline.ts';
import {avoidGraphics} from './validate.ts';
import {gradeFor, lutBakes, type ProjectGrade} from './grade.ts';
import {ms as msToFrames} from './motion.ts';

export type Span = {startMs: number; endMs: number};
export type Zoom = Span & {scale: number; inMs: number; outMs: number}; // a camera push that lives with a title (Orbit)
export type LayerProps = {clips?: Clip[]; captions?: Caption[]; graphics?: Graphic[]; captionStyle?: string; captionsOff?: boolean; textOff?: boolean};
// two ducking ramps (MultiClipVideo's MusicTrack eases 250 ms each way): in a shorter gap the music never gets fully back up
const SPEECH_GAP_MS = 500;

export function captionLayout({clips = [], captions = [], graphics = [], captionStyle, captionsOff = false, textOff = false}: LayerProps, fps: number) {
  const projectedGraphics = projectGraphics(graphics, clips, fps);
  // what the graphics layers draw: a client's master (textOff) leaves the text ones to the supers layer and
  // keeps the decor; a title's camera push moves the footage, so it stays with the footage, drawn title or not
  const drawnGraphics = textOff ? projectedGraphics.filter((g) => !isTextGraphic(g.template)) : projectedGraphics;
  const supers = projectedGraphics.filter((g) => isTextGraphic(g.template));
  const zooms = projectedGraphics.filter((g) => g.camera === 'punch').map((g) => ({startMs: g.startMs - 100, endMs: g.endMs, scale: 0.4, inMs: 333, outMs: 230}));
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
  return {preset, projectedGraphics, drawnGraphics, supers, zooms, shownCaptions, focus, punch, pulses, speech};
}

// What MultiClipVideo's FocusPull does to the footage at a frame: the blur and the scale (about 50 % PULL_ORIGIN_Y %)
// of a focus pull on tier-2 words and B-roll cards, the opening's zoom-blur, Impact II's hero punch and glitch pulse
// (g, also its chromatic split) and a title's camera push (zooms). src/faces.ts reads the scale: where a face lands.
export const PULL_ORIGIN_Y = 38;
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
export function pullAt(frame: number, fps: number, {spans, blurPx, opening = 'none', punch, pulses = [], zooms = []}: {spans: Span[]; blurPx: number; opening?: 'none' | 'zoomBlur' | 'blurIn'; punch?: {spans: Span[]; scale: number}; pulses?: Span[]; zooms?: Zoom[]}) {
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
  return {blur: Math.max(k * blurPx, o * 24, g * 14), scale: 1 + 0.06 * k + (opening === 'zoomBlur' ? 0.1 * o : 0) + (punch?.scale ?? 0) * p + 0.04 * g + z, g};
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

// Why the text graphics cannot be their own supers layer over a text-free master (a client's deliverables):
// one behind the presenter is drawn under the person matte, inside the footage. Decor behind stays in the
// master; a glass plate (label-2tone, location-tag) is drawn solid for a client (src/renderProps.ts), no blur
export function supersBlockers({clips = [], graphics = []}: LayerProps, fps: number): string[] {
  return projectGraphics(graphics, clips, fps).filter((g) => isTextGraphic(g.template) && g.behind)
    .map((g) => `text graphic behind the presenter: ${g.template} ${g.id} (drawn under the person matte, it cannot be its own supers layer)`);
}

// A captions-only job on the client's finished export (Felipe, 2026-09-26: "sí solo quiero captions está bien"):
// the project asks for captions alone (scope ['captions']) and its one clip is the whole source, untouched, with
// nothing drawn or heard over it but the captions. Its master IS the client's file — delivered as it is (a hard
// link), never re-rendered or re-encoded (scripts/render-runner.mjs). → {src} or {src: null, reasons: why not}.
// The runner still probes the file: its frame rate and frame count must be the caption layer's.
export type OriginalProps = LayerProps & {brolls?: unknown[]; mattes?: unknown[]; music?: unknown; grade?: ProjectGrade | null; audio?: {clean?: string; sfx?: boolean} | null};
export function originalMaster(props: OriginalProps, scope: unknown, fps: number): {src: string | null; reasons: string[]} {
  const out: string[] = [];
  if (!Array.isArray(scope) || scope.length !== 1 || scope[0] !== 'captions') out.push('the project does not ask for captions only (set_scope stages: [captions])');
  const clips = props.clips ?? [];
  const c = clips.length === 1 ? clips[0] : null;
  if (!c) out.push(`${clips.length} clips: captions-only delivers one whole source`);
  else {
    const half = 0.5 / fps;
    if (Math.abs(c.inSec) > half || Math.abs(c.outSec - c.sourceDurationSec) > half) out.push(`${c.id} is trimmed (${c.inSec}–${c.outSec} of ${c.sourceDurationSec} s)`);
    // a file of public/clips/ (the runner hard-links it into the version): never a path out of it, never said back
    if (!/^clips\/[^/.][^/]*$/.test(String(c.src))) out.push(`${c.id}'s source is not a file of public/clips/`);
    if ((c.speed ?? 1) !== 1 || (c.volume ?? 1) !== 1 || c.muted || c.transform?.length || (c.enter && c.enter !== 'cut') || c.jSec || c.lSec) out.push(`${c.id} has speed, volume, keyframes, a transition or a J/L cut`);
  }
  const has = (x: unknown) => (Array.isArray(x) ? x.length > 0 : !!x);
  for (const [k, why] of [['graphics', 'graphics'], ['brolls', 'B-roll'], ['mattes', 'person mattes'], ['music', 'music']] as const) if (has(props[k])) out.push(`${why} on the reel`);
  if (c && (gradeFor(props.grade, c.src, c.id) || lutBakes(props.grade, clips).length)) out.push('a grade on the clip');
  if ((props.audio?.clean ?? 'off') !== 'off' || props.audio?.sfx) out.push('audio cleanup or SFX');
  const {preset} = captionLayout(props, fps);
  if (preset.opening !== 'none') out.push(`the ${preset.id} pack opens on the footage (${preset.opening})`);
  out.push(...layerBlockers(props, fps));
  return out.length ? {src: null, reasons: out} : {src: c!.src, reasons: []};
}

// The mode a render runs in: `layers` when asked and possible, `full` otherwise.
// No captions on screen needs no caption layer: the master is the reel (still cached).
// supers: a client's deliverables, whose text graphics are a layer too (supersBlockers)
export function chooseRenderMode(requested: RenderMode | undefined, props: LayerProps, fps: number, {supers = false}: {supers?: boolean} = {}): {mode: RenderMode; reasons: string[]; captions: boolean} {
  const captions = captionLayout(props, fps).shownCaptions.length > 0;
  if (requested !== 'layers') return {mode: 'full', reasons: [], captions};
  const reasons = [...layerBlockers(props, fps), ...(supers ? supersBlockers(props, fps) : [])];
  return {mode: reasons.length ? 'full' : 'layers', reasons, captions};
}
