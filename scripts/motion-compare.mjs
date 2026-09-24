// Our motion next to the reference: a 1 s strip of a Captions.ai preview over a
// 24-frame strip of our project at a timeline time, in one image.
//   node scripts/motion-compare.mjs <ref.mp4> <refSec> <project.json> <ourSec> <out.jpg> [captionStyle]
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {renderStrip} from '../mcp/proof.mjs';

const [ref, refSec, projFile, ourSec, out, style] = process.argv.slice(2);
if (!out) { console.error('usage: node scripts/motion-compare.mjs <ref.mp4> <refSec> <project.json> <ourSec> <out.jpg> [captionStyle]'); process.exit(1); }
const p = JSON.parse(fs.readFileSync(projFile, 'utf8'));
const props = {clips: p.clips, music: null, captions: p.captions, brolls: p.brolls, graphics: p.graphics, mattes: p.mattes, accentColor: p.accentColor, captionStyle: style ?? p.captionStyle, brand: p.brand, grade: p.grade, audio: null};
const ROOT = path.resolve(import.meta.dirname, '..');
const dir = fs.mkdtempSync(path.join(ROOT, '.captions-tmp', 'cmp-'));
const refStrip = path.join(dir, 'ref.jpg');
const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(refSec), '-t', '1.0', '-i', ref, '-vf', 'scale=180:-1,tile=8x3', '-frames:v', '1', refStrip]);
if (r.status !== 0) { console.error(String(r.stderr)); process.exit(1); }
const {sheet, first, fps} = await renderStrip(props, +ourSec, path.join(dir, 'ours'), {frames: 24, cols: 8, scale: 180 / 1080});
const v = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', refStrip, '-i', sheet, '-filter_complex', '[0]scale=1440:-1[a];[1]scale=1440:-1[b];[a][b]vstack', '-q:v', '4', out]);
if (v.status !== 0) { console.error(String(v.stderr)); process.exit(1); }
fs.rmSync(dir, {recursive: true, force: true});
console.log(`${out}: top = ${path.basename(ref)} from ${refSec}s (24 frames at its fps), bottom = ours from ${(first / fps).toFixed(2)}s (24 frames at ${fps} fps)`);
process.exit(0);
