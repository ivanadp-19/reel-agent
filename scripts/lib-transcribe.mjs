// Shared per-clip transcription + assembly onto the trimmed/reordered timeline.
// Used by both the captions pipeline and the B-roll detector.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {DROP_DB, assignSpeakers, flagOffMicBySpeaker, loudnessFromPcm} from '../src/speech.ts';
import {continuesPrev} from '../src/timeline.ts';

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
const LOUD = new Map(); // per process: autocut asks for the same source once per clip
export function loudnessFor(clip) {
  const key = sourceKey(clip);
  if (!LOUD.has(key)) LOUD.set(key, readLoudness(clip, key));
  return LOUD.get(key);
}
function readLoudness(clip, key) {
  const f = path.join(TRANSCRIPTS, `${key}.loud.json`);
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

// ---- Deepgram Nova-3 (optional, pre-recorded API) ----
// DEEPGRAM_API_KEY in .env switches transcription to Deepgram: seconds per clip
// instead of minutes on CPU WhisperX. Words land in the SAME cache format
// ({word, startMs, endMs}), so every downstream step is untouched. Any failure
// (no network, bad key, quota) falls back to local WhisperX for those clips.
// REEL_STT=whisperx forces the local engine even with a key set.
export const useDeepgram = () => Boolean(process.env.DEEPGRAM_API_KEY) && (process.env.REEL_STT || 'auto') !== 'whisperx';

export function parseDeepgramJson(data) {
  const words = data?.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
  return words
    .map((w) => ({word: String(w.punctuated_word ?? w.word).trim(), startMs: Math.round(w.start * 1000), endMs: Math.round(w.end * 1000)}))
    .filter((w) => w.word.length > 0);
}

const DEEPGRAM_TIMEOUT_MS = 60_000; // + ~1 s per 50 KB of audio: a slow uplink still makes it, a stalled one does not hold the job
const DEEPGRAM_RETRY_MS = 500; // one retry on 429 / 5xx
const DEEPGRAM_PARALLEL = 4; // uploads in flight at once

// punctuate: the sentence ends that retakes (cuts.ts), caption pages (paging.ts), off-mic takes
// (speech.ts) and B-roll placement key on — Deepgram is unpunctuated by default. smart_format stays
// off so tokens stay 1:1 with spoken words. filler_words only exists for English (Deepgram docs).
async function deepgramTranscribe(wavPath, lang, attempt = 0) {
  const body = fs.readFileSync(wavPath);
  const params = new URLSearchParams({model: 'nova-3', punctuate: 'true', smart_format: 'false', filler_words: 'true'});
  if (lang === 'auto') params.set('detect_language', 'true');
  else params.set('language', lang);
  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: 'POST',
    headers: {Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': 'audio/wav'},
    body,
    signal: AbortSignal.timeout(DEEPGRAM_TIMEOUT_MS + Math.ceil(body.length / 50)),
  });
  if (res.ok) return parseDeepgramJson(await res.json());
  if ((res.status === 429 || res.status >= 500) && attempt < 1) {
    await new Promise((r) => setTimeout(r, DEEPGRAM_RETRY_MS));
    return deepgramTranscribe(wavPath, lang, attempt + 1);
  }
  throw Object.assign(new Error(`deepgram ${res.status}: ${(await res.text()).slice(0, 160)}`), {status: res.status});
}

// Deepgram for every wav (key → path), DEEPGRAM_PARALLEL at a time; good transcripts land in `dir`
// in the cache format. Returns what is left for WhisperX (failures, degenerate results) and the last
// error, so the caller can name it. A 401/403 ends the batch: a bad key is bad for every clip alike.
export async function deepgramAll(wavs, lang, dir = TRANSCRIPTS) {
  const left = new Map(wavs);
  let lastError = null, dead = false;
  const one = async ([key, wav]) => {
    if (dead) return;
    try {
      const words = await deepgramTranscribe(wav, lang);
      if (isDegenerate(words)) throw new Error('degenerate transcript');
      fs.writeFileSync(path.join(dir, `${key}.${lang}.json`), JSON.stringify(words, null, 2));
      left.delete(key);
    } catch (e) {
      lastError = e;
      if (e.status === 401 || e.status === 403) dead = true;
      console.error(`deepgram failed for ${key} (${String(e).slice(0, 140)}); WhisperX takes it`);
    }
  };
  const entries = [...wavs];
  for (let i = 0; i < entries.length; i += DEEPGRAM_PARALLEL) await Promise.all(entries.slice(i, i + DEEPGRAM_PARALLEL).map(one));
  return {left, lastError};
}

// Transcribe every not-yet-cached source among `clips` (Deepgram when a key is
// set, else one WhisperX batch; Deepgram failures fall back to WhisperX).
// onBatch(label) is called once before the run (for progress UI).
// the transcription time of a job, for the project's timing log: the backend reads this
// stderr line (server/index.mjs → scripts/timing.mjs) and logs it as its own stage
export async function transcribeClips(clips, onBatch, lang = 'auto') {
  const todo = new Set(clips.filter((c) => !fs.existsSync(cacheFile(c, lang))).map((c) => sourceKey(c))).size;
  const t0 = Date.now();
  try { return await transcribeUncached(clips, onBatch, lang); }
  finally { if (todo) console.error(`TIMING:transcribe:${Date.now() - t0}:${todo}`); }
}
async function transcribeUncached(clips, onBatch, lang) {
  fs.mkdirSync(TRANSCRIPTS, {recursive: true});
  fs.mkdirSync(TMP, {recursive: true});
  const pending = new Map(); // key -> clip
  for (const c of clips) if (!fs.existsSync(cacheFile(c, lang))) pending.set(sourceKey(c), c);
  if (!pending.size) return;

  let wavs = new Map(); // key → wav, the sources ffmpeg could convert
  for (const [key, clip] of pending) {
    const wav = path.join(TMP, `${key}.16k.wav`);
    const ff = spawnSync('ffmpeg', ['-y', '-i', path.join(PUBLIC, clip.src), '-ar', '16000', '-ac', '1', wav], {cwd: ROOT});
    if (ff.status !== 0) console.error(`ffmpeg failed for ${key}`);
    else wavs.set(key, wav);
  }
  if (!wavs.size) return;

  if (useDeepgram()) {
    onBatch?.(`Transcribing ${wavs.size} clip${wavs.size === 1 ? '' : 's'} (Deepgram)`);
    const r = await deepgramAll(wavs, lang);
    if (!r.left.size) return;
    wavs = r.left;
    for (const key of [...pending.keys()]) if (!wavs.has(key)) pending.delete(key);
    // Deepgram-only setups: the clips it could not do are skipped per clip
    // (transcribeClip throws for them), not the whole job — the log names why
    if (!fs.existsSync(path.join(ROOT, '.venv', 'bin', 'whisperx'))) {
      console.error(`WhisperX is not installed — ${wavs.size} clip(s) left untranscribed after Deepgram failed: ${String(r.lastError).slice(0, 160)}`);
      return;
    }
  }

  if (!fs.existsSync(path.join(ROOT, '.venv', 'bin', 'whisperx'))) {
    throw new Error('WhisperX is not installed (.venv/bin/whisperx missing) — run `npm run setup`');
  }
  let device = pickDevice();
  const wavList = [...wavs.values()];
  onBatch?.(`Transcribing ${wavList.length} clip${wavList.length === 1 ? '' : 's'} (${device === 'cuda' ? 'GPU' : 'CPU'})`);
  const outDir = path.join(TMP, `batch-${Date.now()}`);
  fs.mkdirSync(outDir, {recursive: true});
  let wx = runWhisperx(wavList, outDir, device, lang);
  if (wx.status !== 0 && device === 'cuda') {
    // e.g. CUDA out of memory / driver mismatch → fall back for this process
    console.error(`whisperx on cuda failed (${wx.stderr?.toString().trim().split('\n').pop()?.slice(0, 160)}); retrying on cpu`);
    DEVICE = device = 'cpu';
    onBatch?.(`Transcribing ${wavList.length} clip${wavList.length === 1 ? '' : 's'} (CPU fallback)`);
    wx = runWhisperx(wavList, outDir, device, lang);
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
export async function transcribeClip(clip, lang = 'auto', offMic = 'mark') {
  const cache = cacheFile(clip, lang);
  if (!fs.existsSync(cache)) await transcribeClips([clip], undefined, lang);
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
export async function assembleWords(clips, onProgress, lang = 'auto', offMic = 'mark') {
  // one transcription run for everything not cached yet
  await transcribeClips(clips, (label) => onProgress?.(0, clips.length, {id: label, label, batch: true}), lang);
  const out = [];
  let offsetMs = 0;
  let anchor;
  for (const [idx, clip] of clips.entries()) {
    onProgress?.(idx, clips.length, clip);
    // a clip that continues the previous one (a split with nothing cut out) is the same take to the speech:
    // its words page with the previous clip's, and a word on the join is emitted once, whole, by the first
    const joined = continuesPrev(clips[idx - 1], clip), goesOn = continuesPrev(clip, clips[idx + 1]);
    anchor = joined ? anchor : clip.id;
    let words;
    try {
      words = await transcribeClip(clip, lang, offMic);
    } catch (e) {
      // one bad clip shouldn't kill the whole job — skip it, keep its slot
      console.error(`SKIP clip ${clip.id}: ${String(e).slice(0, 160)}`);
      offsetMs += (clip.outSec - clip.inSec) * 1000;
      continue;
    }
    const inMs = clip.inSec * 1000;
    const outMs = clip.outSec * 1000;
    words.forEach((w, wi) => {
      if (w.endMs <= inMs || w.startMs >= outMs || (joined && w.startMs < clips[idx - 1].outSec * 1000)) return;
      if (offMic === 'cut' && w.off) return; // the off-camera voice gets no captions
      const s = Math.max(w.startMs, inMs) - inMs + offsetMs;
      const e = (goesOn ? w.endMs : Math.min(w.endMs, outMs)) - inMs + offsetMs;
      out.push({
        wid: `${sourceKey(clip)}:${wi}`, // stable word id
        word: w.word,
        startMs: Math.round(s), // absolute timeline (current cut)
        endMs: Math.round(e),
        clipId: anchor, // anchor: the first clip of its continuous stretch
        src: clip.src, // source file the word belongs to
        srcStartMs: w.startMs, // relative to the clip's own source start
        srcEndMs: w.endMs,
        ...(w.off ? {off: true} : {}),
        ...(w.speaker ? {speaker: w.speaker} : {}),
      });
    });
    offsetMs += (clip.outSec - clip.inSec) * 1000;
  }
  // persist for reuse (e.g. B-roll detection without re-running)
  fs.writeFileSync(path.join(PUBLIC, 'words.multi.json'), JSON.stringify(out, null, 2));
  return out;
}
