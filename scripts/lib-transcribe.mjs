// Shared per-clip transcription + assembly onto the trimmed/reordered timeline.
// Used by both the captions pipeline and the B-roll detector.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {DROP_DB, assignSpeakers, flagOffMicBySpeaker, loudnessFromPcm} from '../src/speech.ts';

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, 'public');
const TRANSCRIPTS = path.join(PUBLIC, 'clips', 'transcripts');
const TMP = path.join(ROOT, '.captions-tmp');

// load .env so REEL_PROMPT works when scripts run standalone
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

// Whisper prompt bias per language (fillers listed so Whisper keeps them —
// they are what autocut wants to find). REEL_PROMPT in .env overrides.
const PROMPTS = {
  es: 'Esta es una narración clara en español de una persona hablando a cámara. Incluye muletillas como eh, este, o sea, mmm. Los nombres propios y marcas van con mayúscula.',
  en: 'The following is a clear English talking-head narration. Include filler words like um, uh, like. Proper nouns, product names and brands are capitalized.',
};
const promptFor = (lang) => process.env.REEL_PROMPT || PROMPTS[lang] || '';

// ---- device selection ----
// REEL_DEVICE=cpu|cuda forces it; default "auto" asks torch once per process.
// GPU: float16. CPU: int8. One whisperx process per BATCH (the model load is most
// of the wall time, so 3 clips on the GPU take ~10 s instead of ~20 s on CPU).
let DEVICE = null;
function pickDevice() {
  if (DEVICE) return DEVICE;
  const forced = (process.env.REEL_DEVICE || 'auto').toLowerCase();
  if (forced === 'cpu' || forced === 'cuda') return (DEVICE = forced);
  const probe = spawnSync('.venv/bin/python', ['-c', 'import torch;print(int(torch.cuda.is_available()))'], {cwd: ROOT});
  DEVICE = probe.status === 0 && probe.stdout.toString().trim() === '1' ? 'cuda' : 'cpu';
  return DEVICE;
}
const computeType = (device) => (device === 'cuda' ? 'float16' : 'int8');

function runWhisperx(wavs, outDir, device, lang, withPrompt = true) {
  const prompt = withPrompt ? promptFor(lang) : '';
  return spawnSync(
    '.venv/bin/whisperx',
    [
      // 'medium' (multilingual) — 'auto' lets whisperx detect the language per file
      ...wavs, '--model', 'medium', ...(lang === 'auto' ? [] : ['--language', lang]), '--device', device, '--compute_type', computeType(device),
      '--output_format', 'json', '--output_dir', outDir, '--vad_onset', '0.2', '--vad_offset', '0.2',
      ...(prompt ? ['--initial_prompt', prompt] : []),
    ],
    {cwd: ROOT},
  );
}

// Word times are relative to the SOURCE file, so the cache is keyed by source
// (+ language): autocut segments and re-arranged copies never re-transcribe.
export const sourceKey = (clip) => path.basename(clip.src).replace(/\.[^.]+$/, '');
const cacheFile = (clip, lang) => path.join(TRANSCRIPTS, `${sourceKey(clip)}.${lang}.json`);

// Loudness sidecar per source (20 ms windows): tells the presenter's takes from
// a quieter voice off camera (a director feeding lines). See src/speech.ts.
export function loudnessFor(clip) {
  const f = path.join(TRANSCRIPTS, `${sourceKey(clip)}.loud.json`);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const ff = spawnSync('ffmpeg', ['-v', 'error', '-i', path.join(PUBLIC, clip.src), '-vn', '-f', 'f32le', '-ac', '1', '-ar', '16000', '-'], {cwd: ROOT, maxBuffer: 1 << 29});
  if (ff.status !== 0 || !ff.stdout?.length) return null;
  const pcm = new Float32Array(ff.stdout.buffer.slice(ff.stdout.byteOffset, ff.stdout.byteOffset + (ff.stdout.length & ~3)));
  const loud = loudnessFromPcm(pcm, 16000, 50);
  fs.mkdirSync(TRANSCRIPTS, {recursive: true});
  fs.writeFileSync(f, JSON.stringify(loud));
  return loud;
}

// Speaker sidecar per source (who is talking): pyannote through scripts/diarize.py, only when HF_TOKEN
// is set (the model is gated). Cached next to the transcript; a failure is logged once and the
// loudness-only detection carries on. REEL_DIARIZE=0 turns it off.
function speakersFor(clip) {
  if (!process.env.HF_TOKEN || process.env.REEL_DIARIZE === '0') return null;
  const f = path.join(TRANSCRIPTS, `${sourceKey(clip)}.spk.json`);
  if (fs.existsSync(f)) { const d = JSON.parse(fs.readFileSync(f, 'utf8')); return d.turns ?? null; }
  const wav = path.join(TMP, `${sourceKey(clip)}.16k.wav`);
  if (!fs.existsSync(wav)) {
    const ff = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', path.join(PUBLIC, clip.src), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], {cwd: ROOT});
    if (ff.status !== 0) return null;
  }
  fs.mkdirSync(TRANSCRIPTS, {recursive: true});
  const r = spawnSync('.venv/bin/python', ['scripts/diarize.py', wav, f], {cwd: ROOT, env: process.env, maxBuffer: 1 << 24});
  if (r.status !== 0 || !fs.existsSync(f)) {
    const tail = (r.stderr?.toString() || '').trim().split('\n').filter((l) => l && !/warn/i.test(l)).slice(-2).join(' | ');
    console.error(`diarization failed for ${sourceKey(clip)} (loudness only): ${tail.slice(-240)}`);
    fs.writeFileSync(f, JSON.stringify({speakers: [], turns: null, error: tail.slice(-240)})); // do not retry every call
    return null;
  }
  return JSON.parse(fs.readFileSync(f, 'utf8')).turns ?? null;
}

function parseWhisperxJson(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const raw = data.segments.flatMap((s) => s.words ?? []);
  return raw
    .map((w, i) => {
      let start = w.start;
      let end = w.end;
      if (start == null) {
        const prev = raw.slice(0, i).reverse().find((x) => x.end != null);
        start = prev ? prev.end : 0;
      }
      if (end == null) {
        const next = raw.slice(i + 1).find((x) => x.start != null);
        end = next ? next.start : start + 0.3;
      }
      return {word: String(w.word).trim(), startMs: Math.round(start * 1000), endMs: Math.round(end * 1000)};
    })
    .filter((w) => w.word.length > 0);
}

// Transcribe every not-yet-cached source among `clips` in ONE whisperx run.
// onBatch(label) is called once before the run (for progress UI).
export function transcribeClips(clips, onBatch, lang = 'auto') {
  fs.mkdirSync(TRANSCRIPTS, {recursive: true});
  fs.mkdirSync(TMP, {recursive: true});
  const pending = new Map(); // key -> clip
  for (const c of clips) if (!fs.existsSync(cacheFile(c, lang))) pending.set(sourceKey(c), c);
  if (!pending.size) return;

  const wavs = [];
  for (const [key, clip] of pending) {
    const wav = path.join(TMP, `${key}.16k.wav`);
    const ff = spawnSync('ffmpeg', ['-y', '-i', path.join(PUBLIC, clip.src), '-ar', '16000', '-ac', '1', wav], {cwd: ROOT});
    if (ff.status !== 0) console.error(`ffmpeg failed for ${key}`);
    else wavs.push(wav);
  }
  if (!wavs.length) return;

  if (!fs.existsSync(path.join(ROOT, '.venv', 'bin', 'whisperx'))) {
    throw new Error('WhisperX is not installed (.venv/bin/whisperx missing) — run `npm run setup`');
  }
  let device = pickDevice();
  onBatch?.(`Transcribing ${wavs.length} clip${wavs.length === 1 ? '' : 's'} (${device === 'cuda' ? 'GPU' : 'CPU'})`);
  const outDir = path.join(TMP, `batch-${Date.now()}`);
  fs.mkdirSync(outDir, {recursive: true});
  let wx = runWhisperx(wavs, outDir, device, lang);
  if (wx.status !== 0 && device === 'cuda') {
    // e.g. CUDA out of memory / driver mismatch → fall back for this process
    console.error(`whisperx on cuda failed (${wx.stderr?.toString().trim().split('\n').pop()?.slice(0, 160)}); retrying on cpu`);
    DEVICE = device = 'cpu';
    onBatch?.(`Transcribing ${wavs.length} clip${wavs.length === 1 ? '' : 's'} (CPU fallback)`);
    wx = runWhisperx(wavs, outDir, device, lang);
  }
  if (wx.error) throw new Error(`whisperx could not start: ${wx.error.message}`);
  if (wx.status !== 0) {
    const tail = (wx.stderr?.toString() || wx.stdout?.toString() || '').trim().split('\n').filter(Boolean).slice(-3).join(' | ');
    throw new Error(`whisperx failed (exit ${wx.status}): ${tail.slice(-300) || 'no output'}`);
  }

  // The prompt bias makes Whisper loop on one word for some short clips
  // ("bueno bueno bueno…"); those are re-run once without it.
  const retry = [];
  for (const key of pending.keys()) {
    const out = path.join(outDir, `${key}.16k.json`);
    if (!fs.existsSync(out)) continue; // ffmpeg failed for this one → transcribeClip will throw
    const words = parseWhisperxJson(out);
    if (isDegenerate(words)) { retry.push(path.join(TMP, `${key}.16k.wav`)); continue; }
    fs.writeFileSync(path.join(TRANSCRIPTS, `${key}.${lang}.json`), JSON.stringify(words, null, 2));
  }
  if (!retry.length) return;
  const outDir2 = path.join(outDir, 'noprompt');
  fs.mkdirSync(outDir2, {recursive: true});
  const wx2 = runWhisperx(retry, outDir2, device, lang, false);
  for (const wav of retry) {
    const key = path.basename(wav, '.16k.wav');
    const out = path.join(outDir2, `${key}.16k.json`);
    if (wx2.status !== 0 || !fs.existsSync(out)) { console.error(`whisperx retry without prompt failed for ${key}`); continue; }
    fs.writeFileSync(path.join(TRANSCRIPTS, `${key}.${lang}.json`), JSON.stringify(parseWhisperxJson(out), null, 2));
  }
}

// A hallucinated loop: 8+ words where one word (case-insensitive, no punctuation) is 60 %+ of them.
export function isDegenerate(words) {
  if (words.length < 8) return false;
  const counts = new Map();
  for (const w of words) { const k = w.word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); counts.set(k, (counts.get(k) ?? 0) + 1); }
  return Math.max(...counts.values()) >= words.length * 0.6;
}

// Words for one clip (source-relative times). Uses the cache; transcribes on miss.
// offMic: 'mark' | 'cut' | 'off' — unless off, words of a quieter second voice
// come back with {off: true} (callers decide whether to skip them; indices stay).
export function transcribeClip(clip, lang = 'auto', offMic = 'mark') {
  const cache = cacheFile(clip, lang);
  if (!fs.existsSync(cache)) transcribeClips([clip], undefined, lang);
  if (!fs.existsSync(cache)) throw new Error(`transcription failed for ${clip.id}`);
  let words = JSON.parse(fs.readFileSync(cache, 'utf8'));
  const turns = speakersFor(clip);
  if (turns) words = assignSpeakers(words, turns);
  if (offMic === 'off') return words;
  const loud = loudnessFor(clip);
  return loud ? flagOffMicBySpeaker(words, loud, +(process.env.REEL_OFFMIC_DB || DROP_DB)) : words;
}

// Assemble all clips' words onto the timeline, honoring trim (in/out) and order.
// onProgress(idx, total, clip) is called before each clip is transcribed.
export function assembleWords(clips, onProgress, lang = 'auto', offMic = 'mark') {
  // one whisperx run for everything not cached yet
  transcribeClips(clips, (label) => onProgress?.(0, clips.length, {id: label, label, batch: true}), lang);
  const out = [];
  let offsetMs = 0;
  clips.forEach((clip, idx) => {
    onProgress?.(idx, clips.length, clip);
    let words;
    try {
      words = transcribeClip(clip, lang, offMic);
    } catch (e) {
      // one bad clip shouldn't kill the whole job — skip it, keep its slot
      console.error(`SKIP clip ${clip.id}: ${String(e).slice(0, 160)}`);
      offsetMs += (clip.outSec - clip.inSec) * 1000;
      return;
    }
    const inMs = clip.inSec * 1000;
    const outMs = clip.outSec * 1000;
    words.forEach((w, wi) => {
      if (w.endMs <= inMs || w.startMs >= outMs) return;
      if (offMic === 'cut' && w.off) return; // the off-camera voice gets no captions
      const s = Math.max(w.startMs, inMs) - inMs + offsetMs;
      const e = Math.min(w.endMs, outMs) - inMs + offsetMs;
      out.push({
        wid: `${sourceKey(clip)}:${wi}`, // stable word id
        word: w.word,
        startMs: Math.round(s), // absolute timeline (current cut)
        endMs: Math.round(e),
        clipId: clip.id, // anchor
        src: clip.src, // source file the word belongs to
        srcStartMs: w.startMs, // relative to the clip's own source start
        srcEndMs: w.endMs,
        ...(w.off ? {off: true} : {}),
        ...(w.speaker ? {speaker: w.speaker} : {}),
      });
    });
    offsetMs += (clip.outSec - clip.inSec) * 1000;
  });
  // persist for reuse (e.g. B-roll detection without re-running)
  fs.writeFileSync(path.join(PUBLIC, 'words.multi.json'), JSON.stringify(out, null, 2));
  return out;
}
