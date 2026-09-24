// Autocut: remove silence at the ENDS and long pauses INSIDE each clip.
// Splits a clip into speech segments at gaps > GAP_THRESH and drops the gaps.
//
// Input : JSON (argv[2]) = {clips:[{id,src,inSec,outSec,sourceDurationSec,...}]}
// Output: public/trim-silence.json = {plan:[{id, segments:[{inSec,outSec}]}]}
// Uses the shared (cached) per-clip transcripts.
import fs from 'node:fs';
import path from 'node:path';
import {transcribeClip, transcribeClips} from './lib-transcribe.mjs';
import {speechSegments} from '../src/cuts.ts';

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, 'public');
const progress = (pct, label) => console.log(`PROGRESS:${pct}:${label}`);

// gaps, pads and minimum length: AUTOCUT in src/cuts.ts

const {clips, lang = 'auto', offMic = 'mark'} = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!clips?.length) { console.error('no clips'); process.exit(1); }

progress(2, 'Starting');
transcribeClips(clips, (label) => progress(5, label), lang); // one whisperx run for all uncached sources
const plan = [];
clips.forEach((clip, i) => {
  progress(5 + Math.round((i / clips.length) * 92), `Analyzing ${clip.label ?? clip.id} (${i + 1}/${clips.length})`);
  let words;
  try {
    words = transcribeClip(clip, lang, offMic);
  } catch (e) {
    console.error(`SKIP ${clip.id}: ${String(e).slice(0, 120)}`);
    return;
  }
  if (offMic === 'cut') words = words.filter((w) => !w.off); // off-camera voice = silence
  if (!words.length) return; // no speech → leave untouched (likely B-roll)

  const segments = speechSegments(words, clip); // only the words under this clip's trim window

  // a piece of a talking take with no word left in it is dead air: an empty plan drops it
  if (!segments.length) { plan.push({id: clip.id, segments: []}); return; }
  // skip clips that effectively don't change (one segment ≈ original)
  const unchanged =
    segments.length === 1 && Math.abs(segments[0].inSec - clip.inSec) < 0.05 && Math.abs(segments[0].outSec - clip.outSec) < 0.05;
  if (unchanged) return;
  plan.push({id: clip.id, segments});
});

fs.writeFileSync(path.join(PUBLIC, 'trim-silence.json'), JSON.stringify({plan}, null, 2));
const cuts = plan.reduce((n, p) => n + p.segments.length, 0);
progress(100, `Done — ${plan.length} clip(s), ${cuts} segment(s)`);
