// Contact-sheet proof for the agent: render a few stills of the composition
// (bundle once per process, then one renderStill per time) and tile them.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {bundle} from '@remotion/bundler';
import {renderStill, selectComposition} from '@remotion/renderer';
import {linkPublic, sweepDead} from '../scripts/public-links.mjs';
import {ensureSfx} from '../scripts/sfx.mjs';

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
  // tile: up to 4 per row
  const cols = Math.min(4, stills.length);
  const rows = Math.ceil(stills.length / cols);
  const sheet = path.join(outDir, 'proof-sheet.jpg');
  const inputs = stills.flatMap((s) => ['-i', s.file]);
  const layout = stills.map((_, i) => `${(i % cols) === 0 ? 0 : Array.from({length: i % cols}, (_, k) => `w${k}`).join('+')}_${Math.floor(i / cols) === 0 ? 0 : Array.from({length: Math.floor(i / cols)}, (_, k) => `h${k * cols}`).join('+')}`).join('|');
  const filter = stills.length === 1 ? 'copy' : `${stills.map((_, i) => `[${i}]`).join('')}xstack=inputs=${stills.length}:layout=${layout}${stills.length % cols ? ':fill=black' : ''}`;
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', filter, '-q:v', '4', sheet]);
  if (r.status !== 0) throw new Error(`ffmpeg tiling failed: ${String(r.stderr).slice(-200)}`);
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
  const layout = stills.map((_, i) => `${(i % cols) === 0 ? 0 : Array.from({length: i % cols}, (_, k) => `w${k}`).join('+')}_${Math.floor(i / cols) === 0 ? 0 : Array.from({length: Math.floor(i / cols)}, (_, k) => `h${k * cols}`).join('+')}`).join('|');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...stills.flatMap((s) => ['-i', s]), '-filter_complex', `${stills.map((_, i) => `[${i}]`).join('')}xstack=inputs=${stills.length}:layout=${layout}`, '-q:v', '4', sheet]);
  if (r.status !== 0) throw new Error(`ffmpeg tiling failed: ${String(r.stderr).slice(-200)}`);
  return {sheet, first, fps: composition.fps};
}
