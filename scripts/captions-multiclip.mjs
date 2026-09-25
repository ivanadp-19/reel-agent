// Caption pages for the assembled multi-clip timeline.
//
// Input : a JSON file (argv[2]) = {clips:[{id,src,inSec,outSec,...}], lang, style}
//         — the editor's CURRENT cut (trim + order).
// Steps : 1) transcribe each source clip with WhisperX (cached per source),
//         2) map words onto the assembled/trimmed timeline,
//         3) face-aware vertical placement (local YuNet),
//         4) page words per the caption preset (src/paging.ts) → public/captions.multi.json
// Accents/emphasis are NOT decided here: the agent annotates via MCP.
// Output: PROGRESS:<pct>:<label> lines on stdout for the server to relay.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {assembleWords, sourceKey} from './lib-transcribe.mjs';
import {pageWords, DEFAULT_TOP} from '../src/paging.ts';
import {presetOf} from '../src/captionPresets.ts';

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, 'public');

const progress = (pct, label) => console.log(`PROGRESS:${pct}:${label}`);

const {clips, lang = 'auto', style, offMic = 'mark'} = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
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

// --- run ---
progress(2, 'Starting');
const words = await assembleWords(clips, (idx, total, clip) =>
  progress(5 + Math.round((idx / total) * 80), clip.batch ? clip.label : `Transcribing ${clip.label ?? clip.id} (${idx + 1}/${total})`), lang, offMic,
);
progress(88, 'Finding faces');
const faces = detectFaces(clips);
const topBySrc = Object.fromEntries(clips.map((c) => [c.src, faceToTop(faces[sourceKey(c)])]));
const captions = pageWords(words, presetOf(style), topBySrc);
fs.writeFileSync(path.join(PUBLIC, 'captions.multi.json'), JSON.stringify(captions, null, 2));
progress(100, `Done — ${captions.length} captions`);
