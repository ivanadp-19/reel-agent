// Autocut: remove silence at the ENDS and long pauses INSIDE each clip.
// Splits a clip into speech segments at gaps > GAP_THRESH and drops the gaps.
//
// Input : JSON (argv[2]) = {clips:[{id,src,inSec,outSec,sourceDurationSec,...}]}
// Output: public/trim-silence.json = {plan:[{id, segments:[{inSec,outSec}]}]}
// Uses the shared (cached) per-clip transcripts.
import fs from 'node:fs';
import path from 'node:path';
import {loudnessFor, transcribeClip, transcribeClips} from './lib-transcribe.mjs';
import {AUTOCUT, speechSegments} from '../src/cuts.ts';

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, 'public');
const progress = (pct, label) => console.log(`PROGRESS:${pct}:${label}`);

// gaps, pads and minimum length: AUTOCUT in src/cuts.ts

const {clips, lang = 'auto', offMic = 'mark'} = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!clips?.length) { console.error('no clips'); process.exit(1); }

progress(2, 'Starting');
await transcribeClips(clips, (label) => progress(5, label), lang); // one whisperx run for all uncached sources
const plan = [];
for (const [i, clip] of clips.entries()) {
  progress(5 + Math.round((i / clips.length) * 92), `Analyzing ${clip.label ?? clip.id} (${i + 1}/${clips.length})`);
  let words;
  try {
    words = await transcribeClip(clip, lang, offMic);
  } catch (e) {
    console.error(`SKIP ${clip.id}: ${String(e).slice(0, 120)}`);
    continue;
  }
  const keep = offMic === 'cut' ? words.filter((w) => !w.off) : words; // off-camera voice = silence
  if (!keep.length) continue; // no speech → leave untouched (likely B-roll)

  // voice activity: a transcript gap with a voice still in it is not a cut
  // point (WhisperX drops words it cannot align); dropped off-mic words explain
  // their own energy, so their gaps are never bridged back (see src/cuts.ts)
  const segments = speechSegments(words, clip, {...AUTOCUT, loud: loudnessFor(clip) ?? undefined, dropOff: offMic === 'cut'});

  // a piece of a talking take with no word left in it is dead air: an empty plan drops it
  if (!segments.length) { plan.push({id: clip.id, segments: []}); continue; }
  // skip clips that effectively don't change (one segment ≈ original)
  const unchanged =
    segments.length === 1 && Math.abs(segments[0].inSec - clip.inSec) < 0.05 && Math.abs(segments[0].outSec - clip.outSec) < 0.05;
  if (unchanged) continue;
  plan.push({id: clip.id, segments});
}

fs.writeFileSync(path.join(PUBLIC, 'trim-silence.json'), JSON.stringify({plan}, null, 2));
const cuts = plan.reduce((n, p) => n + p.segments.length, 0);
progress(100, `Done — ${plan.length} clip(s), ${cuts} segment(s)`);
