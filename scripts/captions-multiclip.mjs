// Caption pages for the assembled multi-clip timeline.
//
// Input : a JSON file (argv[2]) = {clips:[{id,src,inSec,outSec,...}], lang, style}
//         — the editor's CURRENT cut (trim + order).
// Steps : 1) transcribe each source clip with WhisperX (cached per source),
//         2) map words onto the assembled/trimmed timeline,
//         3) face-aware vertical placement (local YuNet),
//         4) page words per the caption preset (src/paging.ts) → public/captions.multi.json
// Yellow words: the project's own tiers (`tiers`, every word it shows) apply exactly; only words it does
// not show yet get the pack's rule-based proposal (src/highlights.ts yellowWords). The agent adjusts them.
// Output: PROGRESS:<pct>:<label> lines on stdout for the server to relay.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {assembleWords, sourceKey} from './lib-transcribe.mjs';
import {yellowWords, applyGuionPunctuation} from '../src/highlights.ts';
import {pageWords, DEFAULT_TOP} from '../src/paging.ts';
import {reconcileWords, reconciliationLine, applyGlossary, joinFigures} from '../src/guion.ts';
import {presetOf} from '../src/captionPresets.ts';

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, 'public');

const progress = (pct, label) => console.log(`PROGRESS:${pct}:${label}`);

const {clips, lang = 'auto', style, offMic = 'mark', tiers = {}, project_id, guion: sentGuion, glossary: sentGlossary} = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
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

// The saved project, for what a caller did not send (the CLI sends neither guion nor glossary)
const saved = (() => {
  if (typeof project_id !== 'string' || !/^[\w-]+$/.test(project_id)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(PUBLIC, 'projects', `${project_id}.json`), 'utf8')); } catch { return null; }
})();
// The guion (client script): the project's own (set_guion, the Captions tab), else REEL_GUION or
// public/guion.txt as before. It reconciles the ASR words (src/guion.ts).
function readGuion() {
  if (typeof sentGuion === 'string' && sentGuion.trim()) return sentGuion; // the caller's current project (the editor may not have saved yet)
  if (typeof saved?.guion === 'string' && saved.guion.trim()) return saved.guion;
  const file = process.env.REEL_GUION ?? (fs.existsSync(path.join(PUBLIC, 'guion.txt')) ? path.join(PUBLIC, 'guion.txt') : null);
  return file ? fs.readFileSync(file, 'utf8') : null;
}
const guion = readGuion();
// the brand kit's glossary: the caller's current one ([] = none), else the saved project's
const glossary = sentGlossary ?? saved?.brand?.glossary ?? [];

// --- run ---
progress(2, 'Starting');
let words = await assembleWords(clips, (idx, total, clip) =>
  progress(5 + Math.round((idx / total) * 80), clip.batch ? clip.label : `Transcribing ${clip.label ?? clip.id} (${idx + 1}/${total})`), lang, offMic,
);
// the guion's wording over the ASR's where they align (keeping the ASR's time); conflicts and
// ambiguous spans stay as heard — validate reports them (guionIssues)
if (guion) {
  const {words: fixed, report} = reconcileWords(words, guion, {keepDigits: presetOf(style).layout.keepDigits});
  words = fixed;
  console.log(reconciliationLine(report));
  for (const c of report.conflicts) console.log(`guion conflict (audio kept): "${c.asr}" vs guion "${c.guion}" at ${c.wid ?? '?'}`);
}
// the brand kit's glossary last: the client's spelling wins over the ASR and the guion ('Alta Brisa' → 'Altabrisa')
if (Array.isArray(glossary) && glossary.length) {
  const {words: fixed, fixed: n} = applyGlossary(words, glossary);
  words = fixed;
  console.log(`glossary: ${n.length} respelled${n.length ? ' — ' + n.map((f) => `"${f.asr}" → "${f.text}"`).join(', ') : ''}`);
}
// figures the ASR spelled out ('cincuenta y cuatro', Deepgram) in digits, as WhisperX writes them — unless a
// guion sets the number style (a pack without layout.keepDigits: its guion's spelling was just adopted)
if (presetOf(style).layout.keepDigits || !guion) words = joinFigures(words);
progress(84, 'Key words');
const nHl = yellowWords(words, tiers, presetOf(style).highlight); // before paging: a highlighted name is one unit
if (nHl) progress(85, `${nHl} key words proposed`);
// v11.1: sentence/clause punctuation from the guion onto the word stream, so pageWords
// breaks at real phrase boundaries (whisper has none).
const guionPathP = process.env.REEL_GUION ?? (fs.existsSync(path.join(PUBLIC, 'guion.txt')) ? path.join(PUBLIC, 'guion.txt') : null);
if (guionPathP) {
  const nP = applyGuionPunctuation(words, fs.readFileSync(guionPathP, 'utf8'));
  if (nP.marks || nP.starts) progress(86, `guion: ${nP.marks} punctuation marks, ${nP.starts} sentence starts`);
}

progress(88, 'Finding faces');
const faces = detectFaces(clips);
const topBySrc = Object.fromEntries(clips.map((c) => [c.src, faceToTop(faces[sourceKey(c)])]));
const captions = pageWords(words, presetOf(style), topBySrc);
fs.writeFileSync(path.join(PUBLIC, 'captions.multi.json'), JSON.stringify(captions, null, 2));
progress(100, `Done — ${captions.length} captions`);
