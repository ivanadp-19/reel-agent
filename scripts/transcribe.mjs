// Transcribe every source in the project (cached per source + language) and
// dump the words of each clip's trim window for the agent (get_transcript).
//
// Input : JSON (argv[2]) = {clips:[...], lang:'auto'|'es'|'en'}
// Output: public/transcript.json = [{clipId, source, words:[{i, word, startMs, endMs, off?, speaker?}]}]
//         off = a quieter second voice away from the mic; speaker = spk1, spk2… from diarization (see src/speech.ts)
//         (times are SOURCE-relative ms; i = index into the source's transcript,
//          so `${source}:${i}` is a stable word id across splits and autocuts)
import fs from 'node:fs';
import path from 'node:path';
import {sourceKey, transcribeClip, transcribeClips} from './lib-transcribe.mjs';

const PUBLIC = path.join(process.cwd(), 'public');
const progress = (pct, label) => console.log(`PROGRESS:${pct}:${label}`);

const {clips, lang = 'auto', offMic = 'mark'} = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!clips?.length) { console.error('no clips'); process.exit(1); }

progress(2, 'Starting');
transcribeClips(clips, (label) => progress(5, label), lang);
const out = clips.map((clip) => {
  let words = [];
  try { words = transcribeClip(clip, lang, offMic); } catch (e) { console.error(`SKIP ${clip.id}: ${String(e).slice(0, 120)}`); }
  const inMs = clip.inSec * 1000, outMs = clip.outSec * 1000;
  return {
    clipId: clip.id,
    source: sourceKey(clip),
    words: words.map((w, i) => ({i, ...w})).filter((w) => w.endMs > inMs && w.startMs < outMs),
  };
});
fs.writeFileSync(path.join(PUBLIC, 'transcript.json'), JSON.stringify(out));
progress(100, `Done — ${out.reduce((n, c) => n + c.words.length, 0)} words`);
