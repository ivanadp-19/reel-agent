// The per-pack motion gate: for every style pack, restyle a project with it (through the MCP server, so the
// captions re-page exactly as the agent's do), give it the pack's signature title, a cut with its transition
// family and a B-roll cue, then put our 24-frame strips under the preview's at three moments (a key word, the
// cut, the title). Writes the sheets and a Markdown report for the subjective gate.
//   node scripts/motion-gate.mjs <project.json> <outDir> [pack,pack,...]
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {PACKS} from '../src/stylePacks.ts';
import {parseProps} from '../src/graphicTemplates.ts';
import {renderStrip} from '../mcp/proof.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const REFS = path.join(ROOT, '.refs', 'captions-ai');
const [projFile, outDir, only] = process.argv.slice(2);
if (!outDir) { console.error('usage: node scripts/motion-gate.mjs <project.json> <outDir> [pack,pack]'); process.exit(1); }
fs.mkdirSync(outDir, {recursive: true});

// the preview moments (seconds) and our moments on the gate project: key word, cut, title
const CUT = 43.0; // source second of the cut we add
const MOMENTS = {
  prism: {ref: 'prism-pro', key: 0.40, cut: 9.00, title: 0.00, hook: {template: 'hook-stack', props: {lines: [{text: 'Real', size: 'lg'}, {text: 'estate', size: 'xl', accent: true}]}}},
  focus: {ref: 'focus', key: 0.60, cut: 3.35, title: 0.45, hook: {template: 'band-title', props: {text: 'FOLLOWERS'}, yPct: 74}},
  stack: {ref: 'stack', key: 0.60, cut: 3.50, title: 0.30, hook: {template: 'big-word', props: {text: 'TECHNOLOGY', font: 'condensed', size: 'xxl'}, yPct: 4}},
  lift: {ref: 'lift', key: 0.75, cut: 3.45, title: 0.45, hook: {template: 'kinetic-card', props: {lines: [{text: 'Your Team'}], bg: 'dark', font: 'serif'}}},
  evo: {ref: 'evo', key: 0.50, cut: 2.50, title: 0.10, hook: {template: 'hook-stack', props: {lines: [{text: 'THE KEYS TO', size: 'md'}, {text: 'INVESTING', size: 'lg', accent: true}], upper: true}, yPct: 70}},
  prime: {ref: 'prime', key: 0.65, cut: 2.98, title: 0.65, hook: {template: 'big-word', props: {text: 'Progress', font: 'script', upper: false, color: 'accent'}, reveal: 'letters', life: 'grow', yPct: 8}},
  orbit: {ref: 'orbit', key: 0.97, cut: 4.15, title: 0.30, hook: {template: 'hook-stack', props: {lines: [{text: 'FRIENDS', size: 'xl'}], upper: true}, camera: 'punch', yPct: 2}},
  impact: {ref: 'impact-ii', key: 0.58, cut: 7.20, title: 0.15, hook: {template: 'hook-stack', props: {lines: [{text: "IT'S ABOUT", size: 'sm', accent: true}, {text: 'BALANCE', size: 'xl'}], upper: true}, yPct: 60}},
  paper: {ref: 'paper-ii', key: 0.60, cut: 6.68, title: 0.40, hook: {template: 'chapter-caps', props: {text: 'PRESENCE', sub: 'WITHOUT PRESSURE', rules: false}, reveal: 'typewriter', yPct: 12}},
  elevate: {ref: 'elevate', key: 1.00, cut: 2.60, title: 0.30, hook: {template: 'script-title', props: {title: 'Momentum', tag: 'a short film', sub: 'advice I wish I knew at 20'}, yPct: 36}},
  sketch: {ref: 'sketch', key: 0.45, cut: 5.00, title: 0.08, hook: {template: 'big-word', props: {text: 'MIND MAP', font: 'display', size: 'lg'}, yPct: 44}},
  lens: {ref: 'lens', key: 0.50, cut: 3.55, title: 0.42, hook: {template: 'big-word', props: {text: 'Aperture', font: 'display', upper: false, color: 'accent', size: 'lg'}, yPct: 14}},
  vista: {ref: 'vista', key: 0.25, cut: 4.60, title: 0.04, hook: {template: 'big-word', props: {text: 'REALTY', font: 'condensed', size: 'xxl', color: 'outline'}, yPct: 0}},
  pop: {ref: 'pop', key: 1.10, cut: 5.13, title: 0.12, hook: {template: 'starburst', props: {text: 'PROJECT', size: 'lg', xPct: 50, anim: 'stamp'}, yPct: 24}},
  y2k: {ref: 'y2k', key: 0.90, cut: 2.95, title: 0.50, hook: {template: 'big-word', props: {text: 'Summer', font: 'script', upper: false, color: 'accent', size: 'lg'}, yPct: 62}},
  form: {ref: 'form', key: 1.05, cut: 0.45, title: 0.30, hook: {template: 'big-word', props: {text: 'RESULTS', font: 'display', color: 'accent', size: 'lg'}, out: 'letters', yPct: 6}},
  bloom: {ref: 'bloom', key: 1.35, cut: 5.80, title: 0.12, hook: {template: 'script-title', props: {title: 'Routine', tag: '', sub: 'MOISTURIZE'}, yPct: 10}},
  chalk: {ref: 'chalk', key: 0.80, cut: 5.17, title: 0.17, hook: {template: 'big-word', props: {text: 'YOUTH', font: 'display', size: 'xl', repeat: true}, reveal: 'letters', yPct: 6}},
  linen: {ref: 'linen', key: 0.17, cut: 6.95, title: 0.21, hook: {template: 'script-title', props: {title: 'WEAR', sub: 'your style', font: 'serif-italic'}, yPct: 6}},
  align: {ref: 'align', key: 0.10, cut: 6.03, title: 0.00, hook: {template: 'chapter-caps', props: {text: 'COMPUTERS', sub: 'MAINFRAMES TO WEARABLES', rules: false}, reveal: 'tracking', yPct: 8}},
};

const base = JSON.parse(fs.readFileSync(projFile, 'utf8'));
const client = new Client({name: 'motion-gate', version: '0'});
await client.connect(new StdioClientTransport({command: 'node', args: [path.join(ROOT, 'mcp', 'server.mjs')], cwd: ROOT}));
const call = async (name, args) => { const r = await client.callTool({name, arguments: args}, undefined, {timeout: 600000}); const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'); if (r.isError) throw new Error(`${name}: ${t}`); return t; };
const strip = (video, sec, out) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(sec), '-t', '1.0', '-i', video, '-vf', 'scale=180:-1,tile=8x3', '-frames:v', '1', out]); if (r.status !== 0) throw new Error(String(r.stderr)); };
const stack = (top, bottom, out) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', top, '-i', bottom, '-filter_complex', '[0]scale=1440:-1[a];[1]scale=1440:-1[b];[a][b]vstack', '-q:v', '4', out]); if (r.status !== 0) throw new Error(String(r.stderr)); };

const rows = [];
const packs = only ? only.split(',') : Object.keys(MOMENTS);
for (const id of packs) {
  const m = MOMENTS[id]; const pack = PACKS[id];
  if (!m || !pack) { console.error(`no moments for ${id}`); continue; }
  const t0 = Date.now();
  // 1. a scratch project restyled by the MCP server (captions re-page for the pack)
  const scratchId = `p-gate-${id}`;
  const clip = base.clips[0];
  const scratch = {...base, name: `gate ${id}`, captionStyle: base.captionStyle, graphics: [], brolls: [], music: null, mattes: base.mattes ?? [], plan: '', clips: [{...clip, outSec: CUT}, {...clip, id: `${clip.id}-2`, inSec: CUT, enter: pack.transition, transform: [{t: CUT, scale: 1.6, x: -8, y: 6}]}]};
  fs.writeFileSync(path.join(ROOT, 'public', 'projects', `${scratchId}.json`), JSON.stringify(scratch));
  await call('set_caption_style', {project_id: scratchId, style: id});
  const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'projects', `${scratchId}.json`), 'utf8'));
  // 2. the pack's signature title over the presenter, a B-roll cue the pack's way, its frame if it has one
  const S = (41.4 + clip.inSec) * 1000;
  const hook = {id: 'g9', src: clip.src, startMs: S, endMs: S + 3000, template: m.hook.template, props: parseProps(m.hook.template, m.hook.props), ...(m.hook.yPct != null ? {yPct: m.hook.yPct} : {}), ...(m.hook.reveal ? {reveal: m.hook.reveal} : {}), ...(m.hook.out ? {out: m.hook.out} : {}), ...(m.hook.life ? {life: m.hook.life} : {}), ...(m.hook.camera ? {camera: m.hook.camera} : {})};
  const graphics = [hook];
  if (pack.layout) graphics.push({id: 'g8', src: clip.src, startMs: S - 400, endMs: S + 3400, template: 'layout', props: parseProps('layout', pack.layout)});
  const cue = base.brolls[0] ? {...base.brolls[0], id: 'bx', startMs: S + 3400, endMs: S + 6400, mode: pack.brollMode ?? 'top', enter: undefined, arrive: undefined, leave: undefined} : null;
  const props = {clips: p.clips, music: null, captions: p.captions, brolls: cue ? [cue] : [], graphics, mattes: p.mattes, accentColor: p.accentColor, captionStyle: id, brand: null, grade: p.grade, audio: null};
  // 3. three strips: the title, a key word (the first tier-2 or tier-1 page after the title), the cut
  const capsAfter = p.captions.filter((c) => c.startMs > S + 3200 && c.words.some((w) => w.tier));
  const keyAt = capsAfter.length ? (capsAfter[0].startMs - clip.inSec * 1000) / 1000 - 0.15 : 44.0;
  const moments = [['title', 41.35, m.title], ['key', keyAt, m.key], ['cut', CUT - clip.inSec - 0.35, m.cut]];
  const dir = path.join(outDir, id); fs.mkdirSync(dir, {recursive: true});
  const sheets = [];
  for (const [name, ours, theirs] of moments) {
    const ref = path.join(dir, `${name}-ref.jpg`); strip(path.join(REFS, `${m.ref}.mp4`), theirs, ref);
    const {sheet} = await renderStrip(props, ours, path.join(dir, `${name}-ours`), {frames: 24, cols: 8, scale: 180 / 1080});
    const out = path.join(dir, `${name}.jpg`); stack(ref, sheet, out); sheets.push(out);
    fs.rmSync(path.join(dir, `${name}-ours`), {recursive: true, force: true}); fs.rmSync(ref, {force: true});
  }
  fs.rmSync(path.join(ROOT, 'public', 'projects', `${scratchId}.json`), {force: true});
  rows.push({id, sheets, sec: Math.round((Date.now() - t0) / 1000), note: pack.note});
  console.log(`${id}: ${sheets.length} sheets in ${Math.round((Date.now() - t0) / 1000)} s`);
}
await client.close();
const rel = (f) => path.relative(ROOT, f);
const md = [`# Gate por style pack (${new Date().toISOString().slice(0, 10)})`, '', 'Por pack, tres tiras de 24 frames: el título de firma, una palabra clave, el corte con la familia del pack. Arriba el preview de Captions.ai, abajo nuestro render del mismo proyecto restilizado por el MCP. El veredicto subjetivo es de Felipe; anota aquí qué pasa y qué no.', '', '| Pack | Título | Palabra clave | Corte | Nota |', '|---|---|---|---|---|', ...rows.map((r) => `| ${r.id} | \`${rel(r.sheets[0])}\` | \`${rel(r.sheets[1])}\` | \`${rel(r.sheets[2])}\` | ${r.note ?? ''} |`), ''];
fs.writeFileSync(path.join(outDir, 'README.md'), md.join('\n'));
console.log('report', path.join(outDir, 'README.md'));
process.exit(0);
