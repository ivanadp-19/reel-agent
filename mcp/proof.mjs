// Contact-sheet proof for the agent: render a few stills of the composition
// (bundle once per process, then one renderStill per time) and tile them.
import fs from 'node:fs';
import path from 'node:path';
import {bundle} from '@remotion/bundler';
import {renderStill, selectComposition} from '@remotion/renderer';
import {linkPublic, sweepDead} from '../scripts/public-links.mjs';
import {ensureSfx} from '../scripts/sfx.mjs';
import {runCmd} from '../scripts/remote-broll.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = path.join(ROOT, '.captions-tmp');
// one bundle per MCP process, in its own dir with public/ as symlinks; removed on exit
const WORK = path.join(TMP, `proof-bundle-${process.pid}`);
let bundled = null;
async function getBundle() {
  if (!bundled) {
    sweepDead(TMP, 'proof-bundle-');
    ensureSfx(); // the composition references public/sfx/*.wav
    const links = linkPublic(path.join(ROOT, 'public'), path.join(WORK, 'public-links'));
    bundled = await bundle({entryPoint: path.join(ROOT, 'src', 'index.ts'), publicDir: links, outDir: path.join(WORK, 'bundle'), onSymlinkDetected: () => {}});
    const clean = () => fs.rmSync(WORK, {recursive: true, force: true});
    process.once('exit', clean);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { clean(); process.exit(0); });
  }
  return bundled;
}

// times in seconds → one JPEG contact sheet (path) + the stills
export async function renderProof(props, times, outDir, scale = 0.35) {
  fs.mkdirSync(outDir, {recursive: true});
  const serveUrl = await getBundle();
  const composition = await selectComposition({serveUrl, id: 'MultiClip', inputProps: props});
  const stills = [];
  for (const t of times) {
    const frame = Math.min(composition.durationInFrames - 1, Math.max(0, Math.round(t * composition.fps)));
    const out = path.join(outDir, `proof-${t.toFixed(2)}.jpg`);
    await renderStill({composition, serveUrl, output: out, inputProps: props, frame, scale, imageFormat: 'jpeg', jpegQuality: 82});
    stills.push({t, file: out});
  }
  // tile: up to 4 per row. Each still carries a yellow strip UNDER the frame
  // ("STILL 12.3 s · proof, not the render") so nobody mistakes the sheet for the
  // video: empty tiles and the strip are not bars of the render.
  const cols = Math.min(4, stills.length);
  const rows = Math.ceil(stills.length / cols);
  const sheet = path.join(outDir, 'proof-sheet.jpg');
  await tile(stills.map((s) => s.file), cols, sheet, stills.map((s) => `STILL ${s.t.toFixed(1)} s - proof, not the render`), Math.round(46 * scale));
  return {sheet, stills, rows, cols};
}

// 24 consecutive frames from atSec → one strip (cols per row), so the agent can
// SEE an arrival, a transition or a title, not just a still. Same bundle.
export async function renderStrip(props, atSec, outDir, {frames = 24, cols = 8, scale = 0.17} = {}) {
  fs.mkdirSync(outDir, {recursive: true});
  const serveUrl = await getBundle();
  const composition = await selectComposition({serveUrl, id: 'MultiClip', inputProps: props});
  const first = Math.max(0, Math.min(composition.durationInFrames - frames, Math.round(atSec * composition.fps)));
  const stills = [];
  for (let i = 0; i < frames; i++) {
    const out = path.join(outDir, `strip-${String(i).padStart(2, '0')}.jpg`);
    await renderStill({composition, serveUrl, output: out, inputProps: props, frame: first + i, scale, imageFormat: 'jpeg', jpegQuality: 80});
    stills.push(out);
  }
  const sheet = path.join(outDir, 'strip.jpg');
  await tile(stills, cols, sheet, stills.map((_, i) => `STILL f${first + i}`), Math.max(11, Math.round(64 * scale)));
  return {sheet, first, fps: composition.fps};
}

// the ffmpeg filter that tiles `n` inputs `cols` per row, each with a label strip
// of `font` px text below it (drawtext); labels = null → plain tiles. Pure, for tests.
export function tileFilter(n, cols, labels = null, font = 16) {
  const layout = Array.from({length: n}, (_, i) => `${(i % cols) === 0 ? 0 : Array.from({length: i % cols}, (_, k) => `w${k}`).join('+')}_${Math.floor(i / cols) === 0 ? 0 : Array.from({length: Math.floor(i / cols)}, (_, k) => `h${k * cols}`).join('+')}`).join('|');
  const esc = (t) => t.replace(/[\\':,;[\]=]/g, (c) => `\\${c}`);
  const strip = Math.round(font * 1.7);
  const label = (i) => `pad=iw:ih+${strip}:0:0:color=0xFFE500,drawtext=text='${esc(labels[i])}':fontcolor=black:fontsize=${font}:x=6:y=h-${strip}+${Math.round((strip - font) / 2)}`;
  if (n === 1) return labels ? label(0) : 'copy';
  const pre = labels ? Array.from({length: n}, (_, i) => `[${i}]${label(i)}[t${i}];`).join('') : '';
  const ins = Array.from({length: n}, (_, i) => (labels ? `[t${i}]` : `[${i}]`)).join('');
  return `${pre}${ins}xstack=inputs=${n}:layout=${layout}${n % cols ? ':fill=0x303030' : ''}`;
}

// tile images into one JPEG; without drawtext (an ffmpeg built without freetype)
// the tiles go out unlabeled rather than not at all. Async: proofs run inside the
// backend too (the MCP over /mcp), whose event loop must keep serving meanwhile.
async function tile(files, cols, out, labels, font) {
  const inputs = files.flatMap((f) => ['-i', f]);
  for (const l of [labels, null]) {
    const r = await runCmd('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', tileFilter(files.length, cols, l, font), '-q:v', '4', out]);
    if (r.code === 0) return;
    if (!l) throw new Error(`ffmpeg tiling failed: ${String(r.stderr).slice(-200)}`);
  }
}
