// Caption pages for the assembled multi-clip timeline.
//
// Input : a JSON file (argv[2]) = {clips:[{id,src,inSec,outSec,...}], lang, style}
//         — the editor's CURRENT cut (trim + order).
// Steps : 1) transcribe each source clip with WhisperX (cached per source),
//         2) map words onto the assembled/trimmed timeline,
//         3) page words per the caption preset (src/paging.ts),
//         4) place the pages clear of every face (src/faces.ts, local YuNet scans) → argv[3] (the backend's job: its own
//            file; by hand: public/captions.multi.json)
// Yellow words: the project's own tiers (`tiers`, every word it shows) apply exactly; only words it does
// not show yet get the pack's rule-based proposal (src/highlights.ts yellowWords). The agent adjusts them.
// Output: PROGRESS:<pct>:<label> lines on stdout for the server to relay.
import fs from 'node:fs';
import path from 'node:path';
import {assembleWords} from './lib-transcribe.mjs';
import {yellowWords, applyGuionPunctuation} from '../src/highlights.ts';
import {pageWords} from '../src/paging.ts';
import {canScanFaces, readFaces, scanFaces} from './face-scan.mjs';
import {placedCaptions} from '../mcp/checks.mjs';
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

// clear of the faces (src/faces.ts): every source on screen — the clips and the project's own B-roll — scanned first
// when it is not yet (scripts/face-scan.mjs), then each page placed by the project's knobs (faceShift / faceHold).
// No venv or model (the VM): the pages stay at the pack's top, with a warning. REEL_FACE_AWARE=0: no scan, no move
let captions = pageWords(words, presetOf(style));
if ((process.env.REEL_FACE_AWARE ?? '1') !== '0') {
  const srcs = [...new Set([...clips, ...(saved?.brolls ?? [])].map((c) => c.src).filter((s) => !/^https?:/i.test(s) && fs.existsSync(path.join(PUBLIC, s))))];
  const todo = srcs.filter((s) => !readFaces(PUBLIC, s));
  for (const [k, src] of todo.entries()) {
    progress(88 + Math.round((k / todo.length) * 10), `Finding faces (${k + 1}/${todo.length})`);
    try { await scanFaces(PUBLIC, src); } catch (e) { console.error(`face scan skipped — captions stay at the pack's top where it is missing: ${String(e?.message ?? e).slice(0, 200)}`); if (e?.retry && !canScanFaces()) break; }
  }
  captions = placedCaptions({...(saved ?? {}), clips, captions, captionStyle: style, brolls: saved?.brolls ?? [], graphics: saved?.graphics ?? []}, PUBLIC);
}
fs.writeFileSync(process.argv[3] ?? path.join(PUBLIC, 'captions.multi.json'), JSON.stringify(captions, null, 2));
progress(100, `Done — ${captions.length} captions`);
