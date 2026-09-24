// Caption pages for the assembled multi-clip timeline.
//
// Input : a JSON file (argv[2]) = {clips:[{id,src,inSec,outSec,...}], lang}
//         — the editor's CURRENT cut (trim + order).
// Steps : 1) transcribe each source clip with WhisperX (cached per source),
//         2) map words onto the assembled/trimmed timeline,
//         3) face-aware vertical placement (local YuNet),
//         4) build Caption[] → public/captions.multi.json
// Accents/emphasis are NOT decided here: the agent annotates via MCP.
// Output: PROGRESS:<pct>:<label> lines on stdout for the server to relay.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {assembleWords, sourceKey} from './lib-transcribe.mjs';

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, 'public');

const progress = (pct, label) => console.log(`PROGRESS:${pct}:${label}`);

const {clips, lang = 'auto'} = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!clips?.length) {
  console.error('no clips');
  process.exit(1);
}

// --- face-aware placement (one frame per source clip → local YuNet) ---
// Captions default to 58% down the frame, which on a talking head lands on the
// mouth. Find the face and put the block just under the chin, or above the
// head when the face sits low. Cached per source file.
// Disable with REEL_FACE_AWARE=0 in .env.
const FACES_DIR = path.join(PUBLIC, 'clips', 'faces');
const TMP = path.join(ROOT, '.captions-tmp');
const MODEL = path.join(ROOT, '.models', 'yunet.onnx');
const BLOCK_PCT = 9; // ≈ two caption lines at 62px on a 1920px frame
const MIN_TOP = 8;
const MAX_TOP = 72; // block bottom ≤ ~81%: stays clear of the Reels UI strip

function faceToTop(face) {
  if (!face?.found) return DEFAULT_TOP;
  const top = face.top * 100;
  const bottom = face.bottom * 100;
  const below = bottom + 3; // a little under the chin
  if (below <= MAX_TOP) return Math.round(Math.max(MIN_TOP, below));
  const above = top - 4 - BLOCK_PCT; // face sits low → go above the head
  return Math.round(Math.min(MAX_TOP, Math.max(MIN_TOP, above)));
}

function detectFaces(clips) {
  if ((process.env.REEL_FACE_AWARE ?? '1') === '0') return {};
  fs.mkdirSync(FACES_DIR, {recursive: true});
  fs.mkdirSync(TMP, {recursive: true});
  const bySource = new Map();
  for (const c of clips) if (!bySource.has(sourceKey(c))) bySource.set(sourceKey(c), c);
  const result = {};
  const pending = [];
  for (const [key, clip] of bySource) {
    const cache = path.join(FACES_DIR, `${key}.json`);
    if (fs.existsSync(cache)) { result[key] = JSON.parse(fs.readFileSync(cache, 'utf8')); continue; }
    // three frames across the trim window (a B-roll gap or a black hold in
    // the middle must not hide the presenter) — first face found wins
    const jpgs = [0.1, 0.5, 0.9].map((f, k) => {
      const t = clip.inSec + Math.max(0, (clip.outSec - clip.inSec) * f);
      const jpg = path.join(TMP, `${key}.face${k}.jpg`);
      const ff = spawnSync('ffmpeg', ['-y', '-ss', String(t), '-i', path.join(PUBLIC, clip.src), '-frames:v', '1', '-vf', 'scale=540:-2', '-q:v', '4', jpg], {cwd: ROOT});
      return ff.status === 0 && fs.existsSync(jpg) ? jpg : null;
    }).filter(Boolean);
    if (jpgs.length) pending.push({key, jpgs});
  }
  if (!pending.length) return result;
  if (!fs.existsSync(MODEL)) {
    console.error('face detection skipped: .models/yunet.onnx missing (run `npm run setup`)');
    return result;
  }
  const py = spawnSync('.venv/bin/python', ['scripts/face.py', MODEL, ...pending.flatMap((p) => p.jpgs)], {cwd: ROOT});
  if (py.status !== 0) {
    console.error('face detection failed, using default caption position:', String(py.stderr).trim().split('\n').pop()?.slice(0, 160));
    return result; // not cached → next run retries
  }
  const faces = JSON.parse(String(py.stdout));
  for (const p of pending) {
    const face = p.jpgs.map((j) => faces[j]).find((f) => f?.found) ?? {found: false};
    result[p.key] = face;
    fs.writeFileSync(path.join(FACES_DIR, `${p.key}.json`), JSON.stringify(face));
  }
  return result;
}

// --- buildCaptions (phrase-aware grouping) ---
const MAX_WORDS = 5;
const GAP_MS = 450; // break on natural pauses (sentence rhythm)
const DEFAULT_TOP = 58;
const PUNCT_ONLY = /^[.,!?;:()\-—¿¡]+$/;
const SENT_END = /[.!?]$/;
const CLAUSE_END = /[,;:]$/; // soft break after a clause
const toDisplay = (w) => w.replace(/[.,;:]+$/g, '').replace(/^[.,;:¿¡]+/g, '');
// function/glue words we should never leave dangling at the end of a line
const GLUE = new Set([
  // en
  'a', 'an', 'the', 'of', 'to', 'and', 'or', 'but', 'in', 'on', 'at', 'for', 'with', 'from', 'by',
  'is', 'was', 'are', 'were', 'be', 'been', 'that', 'this', 'it', 'its', 'as', 'so', 'my', 'your',
  'i', 'we', 'you', 'they', 'he', 'she', 'has', 'have', 'had', 'will', "it's", 'about', 'into',
  // es
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'al', 'y', 'e', 'o', 'u', 'pero',
  'en', 'con', 'por', 'para', 'sin', 'sobre', 'que', 'qué', 'es', 'son', 'está', 'están', 'ser', 'se',
  'mi', 'tu', 'su', 'mis', 'tus', 'sus', 'lo', 'le', 'les', 'me', 'te', 'nos', 'como', 'muy', 'más', 'ya',
]);

function buildCaptions(words, topByClip = {}) {
  const pages = [];
  let cur = [];
  let curClip = null;
  let curSrc = null;
  let skipParen = false;
  // store SOURCE-RELATIVE times (srcStartMs/srcEndMs) + the source file so
  // captions stay anchored to the footage; projectCaptions places them later.
  const flush = () => {
    if (cur.length) {
      pages.push({clipId: curClip, src: curSrc, words: cur, start: cur[0].startMs, end: cur[cur.length - 1].endMs});
      cur = [];
    }
  };
  words.forEach((w, i) => {
    if (w.word === '(') { skipParen = true; flush(); return; }
    if (w.word === ')') { skipParen = false; return; }
    if (skipParen || PUNCT_ONLY.test(w.word)) return;
    const display = toDisplay(w.word);
    if (!display) return;

    if (curClip !== null && w.clipId !== curClip) flush(); // never span two clips
    curClip = w.clipId;
    curSrc = w.src;
    cur.push({text: display, startMs: w.srcStartMs, endMs: w.srcEndMs, accent: false});

    const lastGlue = GLUE.has(display.toLowerCase());
    const next = words[i + 1];
    const sameClipNext = next && next.clipId === w.clipId;
    const gapAfter = sameClipNext && next.startMs - w.endMs > GAP_MS; // gap in absolute time
    if (SENT_END.test(w.word)) flush();
    else if (next && !sameClipNext) flush(); // clip boundary
    else if (!lastGlue && (cur.length >= MAX_WORDS || gapAfter || CLAUSE_END.test(w.word))) flush();
    else if (cur.length >= MAX_WORDS + 2) flush();
  });
  flush();
  // merge 1-word orphans into the previous line (same clip, tight in time)
  for (let k = pages.length - 1; k > 0; k--) {
    const p = pages[k];
    const prev = pages[k - 1];
    if (p.words.length === 1 && p.clipId === prev.clipId && p.start - prev.end < 350 && prev.words.length <= MAX_WORDS) {
      prev.words.push(...p.words);
      prev.end = p.end;
      pages.splice(k, 1);
    }
  }
  return pages.map((p, i) => ({id: `c${i}`, src: p.src, words: p.words, startMs: p.start, endMs: p.end, topPct: topByClip[p.clipId] ?? DEFAULT_TOP}));
}

// --- run ---
progress(2, 'Starting');
const words = assembleWords(clips, (idx, total, clip) =>
  progress(5 + Math.round((idx / total) * 80), clip.batch ? clip.label : `Transcribing ${clip.label ?? clip.id} (${idx + 1}/${total})`), lang,
);
progress(88, 'Finding faces');
const faces = detectFaces(clips);
const topByClip = Object.fromEntries(clips.map((c) => [c.id, faceToTop(faces[sourceKey(c)])]));
const captions = buildCaptions(words, topByClip);
fs.writeFileSync(path.join(PUBLIC, 'captions.multi.json'), JSON.stringify(captions, null, 2));
progress(100, `Done — ${captions.length} captions`);
