// Layered-render benchmark: what a caption edit costs before (one-pass render of
// the whole reel) and after (cached master + caption layer + composite), and
// whether the layered file is the same picture.
//
// The reel is shaped like a client's (not a demo that loops one take): six distinct
// 1080×1920 camera sources with grain (the decoder works), 14 takes that never reuse
// footage, J/L-cuts, cover and reveal transitions, three B-roll cues from their own
// sources, a hook and a location tag, a color grade, music that ducks under the
// speech, and ~60 s of Spanish captions paged by the real pager (src/paging.ts) with
// uneven word gaps, compound names ("San Juan de los Lagos", "Montealbán 326") and
// key words. The caption edit is the tedious kind: fix a word's spelling, promote a
// key word, nudge a page up.
//
// It goes through the running backend (the same queue, modes and QC the editor
// and the MCP use): start it first (npm start, or node server/index.mjs).
//
//   node scripts/layers-bench.mjs [--api http://127.0.0.1:3333] [--draft] [--pack palabra] [--alpha-compare]
//                                 [--font-files fonts/A-700.woff2,fonts/A-800.woff2]
// --font-files: a brand kit with the client's own font (files under public/fonts/, as
// set_brand font_files leaves them) for captions and titles instead of the catalog.
//
// Results: research/layers-benchmark.md. Fixtures land in public/bench-layers/ (gitignored).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pageWords} from '../src/paging.ts';
import {presetOf} from '../src/captionPresets.ts';
import {placeClips} from '../src/timeline.ts';
import {ALPHA, captionArgs, compositeArgs} from './layers.mjs';
import {linkPublic} from './public-links.mjs';
import {renderPlan} from './render-queue.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const DIR = 'bench-layers';
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1] ?? true; };
const API = arg('api', process.env.REEL_API || `http://127.0.0.1:${process.env.REEL_PORT || 3333}`);
const DRAFT = process.argv.includes('--draft');
const PACK = arg('pack', 'palabra');
const FPS = 30;
const FONT_FILES = arg('font-files', '') ? String(arg('font-files')).split(',') : [];

const ff = (args) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], {encoding: 'utf8', maxBuffer: 1 << 26}); if (r.status !== 0) throw new Error(r.stderr); return r; };
// a camera-like source: its own picture generator, grain, a phone bitrate; a voice-ish tone that pauses
function fixture(name, sec, video, audio = true) {
  const rel = `${DIR}/${name}.mp4`, f = path.join(PUBLIC, rel);
  if (fs.existsSync(f)) return rel;
  fs.mkdirSync(path.dirname(f), {recursive: true});
  const [gen, ...fx] = video.split(',');
  const vf = [...fx, 'scale=1080:1920:force_original_aspect_ratio=increase', 'crop=1080:1920', 'setsar=1', 'fps=30', 'noise=alls=10:allf=t'].join(',');
  const a = audio ? ['-f', 'lavfi', '-i', `sine=f=${150 + name.length * 13}:d=${sec},tremolo=f=3.1:d=0.9,volume=0.5`] : [];
  ff(['-f', 'lavfi', '-i', gen, ...a, '-vf', vf, '-t', String(sec),
    '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '14M', '-maxrate', '18M', '-bufsize', '28M', '-pix_fmt', 'yuv420p', '-g', '30',
    ...(audio ? ['-c:a', 'aac', '-ar', '48000'] : ['-an']), '-shortest', '-movflags', '+faststart', `${f}.part.mp4`]);
  fs.renameSync(`${f}.part.mp4`, f);
  return rel;
}
function musicFixture(sec) {
  const rel = `${DIR}/music.m4a`, f = path.join(PUBLIC, rel);
  if (fs.existsSync(f)) return rel;
  ff(['-f', 'lavfi', '-i', `sine=f=220:d=${sec}`, '-f', 'lavfi', '-i', `sine=f=277:d=${sec}`, '-f', 'lavfi', '-i', `sine=f=330:d=${sec}`,
    '-filter_complex', '[0][1][2]amix=inputs=3,tremolo=f=2:d=0.4,volume=0.8', '-c:a', 'aac', '-ar', '48000', `${f}.part.m4a`]);
  fs.renameSync(`${f}.part.m4a`, f);
  return rel;
}

const SCRIPT = `Hoy te enseño la casa más bonita de San Juan de los Lagos. Está en Montealbán 326, a dos cuadras del centro.
Tiene tres recámaras, dos baños completos y una terraza con vista a la catedral. La cocina es abierta, con isla de granito,
y todo el piso es de madera sólida. En la planta alta hay un estudio que puedes usar como oficina o como cuarto de visitas.
El jardín tiene riego automático y un asador para los domingos con la familia. La cochera es para dos autos y hay bodega.
El precio es de tres millones doscientos mil pesos, y todavía se puede negociar. Si te interesa, mándame mensaje hoy mismo,
porque esta casa no va a durar. Guarda este video y compártelo con quien esté buscando casa en Jalisco.`.split(/\s+/);

function project() {
  const gens = ['testsrc2=s=1080x1920:r=30', 'mandelbrot=s=540x960:r=30', 'life=s=540x960:r=30:mold=10:ratio=0.2:death_color=#203040:life_color=#e0c080', 'cellauto=s=540x960:r=30:rule=110', 'gradients=s=1080x1920:r=30:speed=0.02:n=5', 'smptehdbars=s=1080x1920:r=30,hue=H=t*0.4'];
  const srcs = gens.map((g, i) => fixture(`cam-${i}`, 22, g));
  const brolls = ['testsrc=s=1080x1920:r=30,hue=h=200', 'mandelbrot=s=540x960:r=30:start_scale=0.5', 'gradients=s=1080x1920:r=30:speed=0.05:c0=#ff8800:c1=#0044ff'].map((g, i) => fixture(`broll-${i}`, 6, g, false));
  const music = musicFixture(75);
  // 14 takes: each source used for two or three non-overlapping ranges (a real selects pass)
  const lens = [4.6, 3.8, 5.2, 4.1, 3.4, 4.9, 4.4, 3.9, 5.0, 4.2, 3.6, 4.8, 4.3, 4.5];
  const enters = [undefined, 'cut', 'whip', 'cut', 'punch', 'cut', 'crossBlur', 'cut', 'zoom', 'cut', 'flash', 'cut', 'cut', 'polyWipe'];
  const used = srcs.map(() => 0.5);
  const clips = lens.map((len, i) => {
    const s = i % srcs.length, inSec = used[s];
    used[s] += len + 1.3; // the retake or silence between two takes of one source
    return {id: `take${i}`, src: srcs[s], inSec: +inSec.toFixed(2), outSec: +(inSec + len).toFixed(2), sourceDurationSec: 22,
      ...(enters[i] ? {enter: enters[i]} : {}), ...(i === 5 ? {jSec: 0.4} : {}), ...(i === 9 ? {lSec: 0.5} : {}),
      ...(i % 4 === 2 ? {transform: [{t: inSec, scale: 1, x: 0, y: 0}, {t: inSec + len, scale: 1.12, x: 0, y: -2}]} : {})};
  });
  // the words: spread over the takes with uneven gaps (a breath, a hesitation, a long pause)
  const words = [];
  let w = 0;
  for (const {clip, startMs} of placeClips(clips, FPS)) {
    let t = clip.inSec * 1000 + 180;
    while (w < SCRIPT.length && t < clip.outSec * 1000 - 450) {
      const word = SCRIPT[w], dur = 140 + word.length * 38;
      const tier = /^(bonita|Montealbán|326|terraza|granito|millones|negociar|Guarda)/.test(word) ? (/millones|bonita/.test(word) ? 2 : 1) : 0;
      words.push({wid: `${clip.src}:${w}`, word, src: clip.src, clipId: clip.id, srcStartMs: Math.round(t), srcEndMs: Math.round(t + dur), startMs: Math.round(startMs + t - clip.inSec * 1000), endMs: Math.round(startMs + t + dur - clip.inSec * 1000), tier});
      t += dur + [40, 90, 60, 320, 70, 150, 55, 600][w % 8];
      w++;
    }
  }
  const captions = pageWords(words, presetOf(PACK)).map((c, i) => ({...c, id: `p${i}`}));
  const at = (i, ms) => ({src: clips[i].src, startMs: Math.round(clips[i].inSec * 1000 + ms)});
  const graphics = [
    {id: 'hook', ...at(0, 200), endMs: at(0, 3000).startMs, template: 'hook-stack', props: {lines: [{text: 'La casa más', size: 'md'}, {text: 'BONITA', size: 'xl', accent: true}]}},
    {id: 'loc', ...at(1, 400), endMs: at(1, 2800).startMs, template: 'location-tag', props: {place: 'Montealbán 326', sub: 'San Juan de los Lagos'}},
    {id: 'price', ...at(10, 300), endMs: at(10, 2700).startMs, template: 'stat', props: {value: '$3.2M', label: 'negociable'}},
  ];
  // B-roll anchored to a take (source-relative ms)
  const cue = (id, i, a, b, extra) => ({id, clipId: clips[i].id, startMs: at(i, a).startMs, endMs: at(i, b).startMs, kind: 'video', ...extra});
  const brollItems = [
    cue('b0', 3, 800, 3000, {mode: 'fullscreen', src: brolls[0], enter: 'cut'}),
    cue('b1', 6, 500, 2600, {mode: 'inset', src: brolls[1]}),
    cue('b2', 11, 600, 2900, {mode: 'fullscreen', src: brolls[2], enter: 'whip'}),
  ];
  return {
    clips, captions, brolls: brollItems, graphics, mattes: [],
    music: {src: music, volume: 0.25, startSec: 0, fadeOutSec: 1.5, duck: true, duckLevel: 0.25},
    accentColor: '#FFB020', captionStyle: PACK,
    brand: FONT_FILES.length ? {colors: {accent: '#FFB020'}, fonts: {display: 'Bench Sans', body: 'Bench Sans', files: FONT_FILES.map((file) => ({family: 'Bench Sans', file, weight: +(file.match(/(\d00)/)?.[1] ?? 700)}))}} : null, audio: {clean: 'light', sfx: true},
    grade: {look: 'clean', intensity: 0.8, auto: false, bySrc: {}},
  };
}

// the tedious caption review: a spelling fix, a promoted key word, a page nudged up (timing untouched)
function captionEdit(p) {
  const captions = structuredClone(p.captions);
  captions[4].words[0].text = captions[4].words[0].text.toUpperCase();
  const pg = captions[9]; pg.words[pg.words.length - 1].tier = 1;
  captions[14].topPct = 52; captions[14].pin = true;
  return {...p, captions};
}

async function render(props, mode) {
  const t0 = Date.now();
  const {jobId, error} = await fetch(`${API}/api/render`, {method: 'POST', body: JSON.stringify({...props, mode, draft: DRAFT})}).then((r) => r.json());
  if (!jobId) throw new Error(error);
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const s = await fetch(`${API}/api/render/${jobId}`).then((r) => r.json());
    if (s.status === 'done') return {...s, wallSec: +((Date.now() - t0) / 1000).toFixed(1), path: path.join(PUBLIC, s.file)};
    if (s.status === 'error') throw new Error(s.error);
  }
}

// SSIM + PSNR of b against a, per frame → {frames, ssimMin, ssimMean, psnrMin, worst: [frame, ssim]}
function compare(a, b) {
  const log = path.join(ROOT, '.captions-tmp', `ssim-${process.pid}.log`);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', a, '-i', b, '-lavfi', `[0:v]setpts=N[x];[1:v]setpts=N[y];[x][y]ssim=stats_file=${log}`, '-f', 'null', '-'], {encoding: 'utf8'});
  if (r.status !== 0) throw new Error(r.stderr);
  const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => ({n: +l.match(/n:(\d+)/)[1], ssim: +l.match(/All:([\d.]+)/)[1]}));
  fs.rmSync(log, {force: true});
  const frames = (f) => +spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', f], {encoding: 'utf8'}).stdout.trim();
  const worst = [...rows].sort((x, y) => x.ssim - y.ssim).slice(0, 5).map((x) => [x.n, +x.ssim.toFixed(4)]);
  return {framesA: frames(a), framesB: frames(b), ssimMin: +Math.min(...rows.map((x) => x.ssim)).toFixed(4), ssimMean: +(rows.reduce((s, x) => s + x.ssim, 0) / rows.length).toFixed(4), worst};
}

const props = project();
const edited = captionEdit(props);
const sec = placeClips(props.clips, FPS).reduce((s, c) => s + c.durFrames, 0) / FPS;
console.log(`reel: ${sec.toFixed(1)} s, ${props.clips.length} takes from ${new Set(props.clips.map((c) => c.src)).size} sources, ${props.captions.length} caption pages, pack ${PACK}, ${DRAFT ? 'draft' : 'final'}, ${os.cpus().length} vCPU`);

const out = {date: new Date().toISOString(), cpus: os.cpus().length, videoSec: +sec.toFixed(1), pages: props.captions.length, pack: PACK, draft: DRAFT, runs: {}};
const keep = (name, r) => { out.runs[name] = {wallSec: r.wallSec, renderSec: r.renderSec, stages: r.stages, mode: r.mode, master: r.master}; console.log(`${name}: ${r.wallSec} s wall (${JSON.stringify(r.stages)}) mode ${r.mode}${r.master ? `, master ${r.master}` : ''}`); return r; };

const fullA = keep('full, first render', await render(props, 'full'));
const layA = keep('layers, first render (master cold)', await render(props, 'layers'));
const fullB = keep('full, after a caption edit', await render(edited, 'full'));
const layB = keep('layers, after a caption edit (master cached)', await render(edited, 'layers'));
out.quality = {first: compare(fullA.path, layA.path), edit: compare(fullB.path, layB.path)};
console.log('layered vs one-pass, per frame:', JSON.stringify(out.quality));

// VP9 alpha vs ProRes 4444 for the caption layer: render + composite, same master
if (process.argv.includes('--alpha-compare')) {
  const plan = renderPlan();
  const master = path.join(ROOT, '.captions-tmp', 'bench-master.mp4');
  fs.copyFileSync(layB.path, master); // stands in for the master: same size and codec
  out.alpha = {};
  for (const alpha of Object.keys(ALPHA)) {
    const links = linkPublic(PUBLIC, path.join(ROOT, '.captions-tmp', `render-public-bench-alpha`));
    const propsFile = path.join(ROOT, `.props-bench-alpha.json`);
    fs.writeFileSync(propsFile, JSON.stringify({...edited, layer: 'captions'}));
    const layer = path.join(ROOT, '.captions-tmp', `bench-captions.${ALPHA[alpha].ext}`);
    let t = Date.now();
    const r = spawnSync('npx', captionArgs({outFile: layer, propsFile, publicDir: links, draft: DRAFT, concurrency: plan.concurrency, cacheBytes: plan.cacheBytes, alpha}), {cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28});
    if (r.status !== 0) throw new Error(r.stderr.slice(-800));
    const renderSec = (Date.now() - t) / 1000;
    t = Date.now();
    const comp = path.join(ROOT, '.captions-tmp', `bench-comp-${alpha}.mp4`);
    const c = spawnSync('ffmpeg', compositeArgs({master, overlays: [{file: layer, alpha}], outFile: comp, fps: FPS, draft: DRAFT}), {encoding: 'utf8'});
    if (c.status !== 0) throw new Error(c.stderr.slice(-800));
    out.alpha[alpha] = {renderSec: +renderSec.toFixed(1), compositeSec: +((Date.now() - t) / 1000).toFixed(1), layerMB: +(fs.statSync(layer).size / 1e6).toFixed(1)};
    console.log(`${alpha}: ${JSON.stringify(out.alpha[alpha])}`);
    for (const f of [layer, comp, propsFile]) fs.rmSync(f, {force: true});
    fs.rmSync(links, {recursive: true, force: true});
  }
  fs.rmSync(master, {force: true});
}
console.log(JSON.stringify(out));
