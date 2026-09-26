// The golden check: a reel the client approved, pinned as a folder public/goldens/<name>/
// (client media and text: gitignored, never committed; only this checker is in the repo).
//   words.json     [{wid, text, startMs, endMs, tier}] — the words as said (source ms, one source
//                  from 0), in the approved wording, with the approved tiers
//   expected.json  {pack, source, sourceSec, width, height, frameOffset, capTop,
//                   pages: [{wids: [first, last], text, lines, yellow: [wid], refFirst, refLast}]}
//                  refFirst / refLast = first / last frame of the page in ref.mp4;
//                  our frame = ref frame + frameOffset
//   ref.mp4        the approved render
// Layer A (no render): the real pager (src/paging.ts pageWords) on the pinned words with the pack
//   → each page's word range, text, yellow words and lines (flex-wrap as the browser does it: the
//   pack's font file when it is on the machine, else the textFit estimate), against expected.
// Layer B (one render): the expected pages as the layered export's caption layer (transparent, the
//   same CaptionTrack; its alpha gives exact glyph masks, so no clean second render) at the
//   reference size; per page: first / last visible frame (±3 f), first-line cap top (±2 px), no
//   recentering while it builds (every glyph column within 2 px of a column of the settled line),
//   the settled glyphs against ref.mp4's (its background = the source frame, color-fit; ±2 px
//   shift, 1 px boundary tolerance, ≥ 0.9 of both masks' pixels shared); and the yellow / white
//   cap-height ratio (1.12–1.20).
// usage: npm run golden <name|dir> [-- --a | --b | --keep]   a pass/fail table, exit 1 on a fail
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {pageWords, DEFAULT_TOP} from '../src/paging.ts';
import {presetOf} from '../src/captionPresets.ts';
import {fitPage, realAdvances, wrapUnits} from '../src/captionLayout.ts';
import {readFont} from '../src/sfnt.ts';
import {projectRenderProps} from '../src/renderProps.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const FPS = 30;
const TOL = {frames: 3, capTopPx: 2, shiftPx: 2, match: 0.9, ratio: [1.12, 1.2]};

// ---------- Layer A ----------

// advance widths (em) of a TrueType / OpenType file (src/sfnt.ts)
export const fontAdvances = (file) => readFont(fs.readFileSync(file)).advance;

// the lines of a page as the renderer lays it out: font size from fitPage (as CaptionTrack), then
// flex-wrap at the padded width with each word's real advance (the pack's tracking per character)
export function pageLines(page, preset, measure) {
  const fit = fitPage(page, preset);
  const gapEm = preset.font.wordGapEm ?? 0.26;
  const shown = (w) => (preset.font.case === 'upper' ? w.text.toUpperCase() : w.text);
  const wordEm = (w) => (measure(shown(w)) * fit.fontSize * (preset.tiers[w.tier ?? 0]?.scale ?? 1) + preset.font.trackingPx * [...shown(w)].length) / fit.fontSize;
  const units = measure ? fit.units.map((u) => {
    const ws = page.words.slice(u.from, u.to + 1);
    return {...u, em: ws.reduce((s, w) => s + wordEm(w), 0) + gapEm * (ws.length - 1)};
  }) : fit.units;
  const starts = wrapUnits(units, fit.fontSize, fit.wrapPx, gapEm).map((k) => units[k].from);
  return starts.map((s, i) => page.words.slice(s, starts[i + 1]).map(shown).join(' '));
}

const nfc = (s) => s.normalize('NFC');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// pinned words → pages with the pack's own pager → the checks against expected, matched by word range
export function layerA(words, exp, {measure = null} = {}) {
  const preset = presetOf(exp.pack);
  const tw = words.map((w) => ({wid: w.wid, word: w.text, src: exp.source, clipId: 'golden', startMs: w.startMs, endMs: w.endMs, srcStartMs: w.startMs, srcEndMs: w.endMs, tier: w.tier ?? 0}));
  const pages = pageWords(tw, preset, {});
  const byRange = new Map(pages.map((p) => [`${p.words[0].wid}…${p.words.at(-1).wid}`, p]));
  const upper = (s) => nfc(preset.font.case === 'upper' ? s.toUpperCase() : s);
  const rows = [{page: '*', check: 'pages', ok: pages.length === exp.pages.length, got: pages.length, want: exp.pages.length}];
  exp.pages.forEach((e, k) => {
    const p = byRange.get(`${e.wids[0]}…${e.wids[1]}`);
    const page = `P${k + 1}`;
    if (!p) {
      const i0 = words.findIndex((w) => w.wid === e.wids[0]), i1 = words.findIndex((w) => w.wid === e.wids[1]);
      const inside = new Set(words.slice(i0, i1 + 1).map((w) => w.wid));
      const got = pages.filter((q) => q.words.some((w) => inside.has(w.wid))).map((q) => upper(q.words.map((w) => w.text).join(' '))).join(' | ');
      rows.push({page, check: 'range', ok: false, got, want: nfc(e.text)});
      return;
    }
    const got = {text: upper(p.words.map((w) => w.text).join(' ')), yellow: p.words.filter((w) => (w.tier ?? 0) > 0).map((w) => w.wid), lines: pageLines(p, preset, measure).map(nfc)};
    rows.push({page, check: 'range', ok: true});
    rows.push({page, check: 'text', ok: got.text === nfc(e.text), got: got.text, want: nfc(e.text)});
    rows.push({page, check: 'yellow', ok: same(got.yellow, e.yellow), got: got.yellow.join(' '), want: e.yellow.join(' ')});
    rows.push({page, check: measure ? 'lines' : 'lines~', ok: same(got.lines, e.lines.map(nfc)), got: got.lines.join(' / '), want: e.lines.join(' / ')});
  });
  return rows;
}

// ---------- Layer B: frames and masks ----------

// raw frames from ffmpeg, one callback per frame (the buffer is reused: copy what you keep)
function decode(args, frameBytes, onFrame) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-v', 'error', ...args, '-f', 'rawvideo', 'pipe:1']);
    const buf = Buffer.alloc(frameBytes);
    let fill = 0, n = 0, err = '';
    ff.stdout.on('data', (d) => {
      for (let o = 0; o < d.length;) {
        const k = Math.min(d.length - o, frameBytes - fill);
        d.copy(buf, fill, o, o + k); fill += k; o += k;
        if (fill === frameBytes) { onFrame(buf, n++); fill = 0; }
      }
    });
    ff.stderr.on('data', (d) => (err += d));
    ff.on('error', reject);
    ff.on('close', (code) => (code ? reject(new Error(`ffmpeg: ${err.trim()}`)) : resolve(n)));
  });
}
// the frames numbered `list` of a video, scaled to w×h and cropped to the band (rgb24)
async function framesAt(file, list, {w, h, y0, bh}) {
  const want = [...new Set(list)].sort((a, b) => a - b), out = new Map();
  const vf = `select='${want.map((n) => `eq(n\\,${n})`).join('+')}',scale=${w}:${h},crop=${w}:${bh}:0:${y0}`;
  await decode(['-i', file, '-vf', vf, '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24'], w * bh * 3, (b, i) => out.set(want[i], Buffer.from(b)));
  return out;
}

// binary morphology on a w×h Uint8Array: 3×3 square min/max (separable), and cross (4-neighbour) dilation
function square(m, w, h, grow) {
  const pass = (src, dx, dy) => {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, a = x - dx >= 0 && y - dy >= 0 ? src[i - dx - dy * w] : 0, c = x + dx < w && y + dy < h ? src[i + dx + dy * w] : 0;
      out[i] = grow ? src[i] | a | c : src[i] & a & c;
    }
    return out;
  };
  return pass(pass(m, 1, 0), 0, 1);
}
const open3 = (m, w, h) => square(square(m, w, h, false), w, h, true);
function dilateCross(m, w, h, times) {
  let cur = m;
  for (let k = 0; k < times; k++) {
    const out = new Uint8Array(cur.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      out[i] = cur[i] | (x > 0 ? cur[i - 1] : 0) | (x < w - 1 ? cur[i + 1] : 0) | (y > 0 ? cur[i - w] : 0) | (y < h - 1 ? cur[i + w] : 0);
    }
    cur = out;
  }
  return cur;
}
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
// a caption glyph's fill: bright, neutral or yellow (the halo is dark, footage rarely both)
const glyphColor = (r, g) => Math.min(r, g) > 172 && Math.abs(r - g) < 45;

// our caption layer (rgba): 0 none, 1 white glyph, 2 yellow glyph (glyph-colored, alpha ≥ minAlpha:
// 230 is as thin as the reference's glyphs read, 128 is the glyph's true edge);
// `seen` = pixels drawn at all (a word's faint first frame and its halo count)
function ourClasses(rgba, w, h, minAlpha = 230) {
  const m = new Uint8Array(w * h);
  let seen = 0;
  for (let i = 0; i < w * h; i++) {
    const a = rgba[4 * i + 3];
    if (a >= 40) seen++;
    if (a >= minAlpha && glyphColor(rgba[4 * i], rgba[4 * i + 1])) m[i] = 1;
  }
  const core = open3(m, w, h);
  for (let i = 0; i < w * h; i++) if (core[i]) core[i] = rgba[4 * i + 2] < 100 ? 2 : 1;
  return {core, seen};
}

// the reference's glyphs: pixels that differ from its background (the source frame through a
// per-channel cubic fit on the rows outside the captions), glyph-colored and not darker than it
function fitGrade(src, ref, w, rows) {
  const coef = [];
  let res = 0, n = 0;
  for (let c = 0; c < 3; c++) {
    const A = Array.from({length: 4}, () => new Float64Array(5));
    for (const y of rows) for (let x = 0; x < w; x++) {
      const i = 3 * (y * w + x) + c, v = src[i] / 255, f = [1, v, v * v, v * v * v];
      for (let r = 0; r < 4; r++) { for (let k = 0; k < 4; k++) A[r][k] += f[r] * f[k]; A[r][4] += f[r] * ref[i]; }
    }
    for (let p = 0; p < 4; p++) for (let r = p + 1; r < 4; r++) { const q = A[r][p] / A[p][p]; for (let k = p; k < 5; k++) A[r][k] -= q * A[p][k]; }
    const x = [0, 0, 0, 0];
    for (let p = 3; p >= 0; p--) x[p] = (A[p][4] - [1, 2, 3].filter((k) => k > p).reduce((s, k) => s + A[p][k] * x[k], 0)) / A[p][p];
    coef.push(x);
  }
  const at = (v, c) => { const s = v / 255, k = coef[c]; return Math.min(255, Math.max(0, k[0] + k[1] * s + k[2] * s * s + k[3] * s * s * s)); };
  for (const y of rows) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) { const i = 3 * (y * w + x) + c; res += Math.abs(at(src[i], c) - ref[i]); n++; }
  return {at, residual: res / n};
}
function refCore(ref, src, w, h, fit) {
  const seed = new Uint8Array(w * h), m = new Uint8Array(w * h), bg = new Float32Array(3 * w * h);
  for (let i = 0; i < 3 * w * h; i++) bg[i] = fit.at(src[i], i % 3);
  for (let i = 0; i < w * h; i++) seed[i] = Math.max(Math.abs(ref[3 * i] - bg[3 * i]), Math.abs(ref[3 * i + 1] - bg[3 * i + 1]), Math.abs(ref[3 * i + 2] - bg[3 * i + 2])) > 30 ? 1 : 0;
  const near = dilateCross(seed, w, h, 4);
  for (let i = 0; i < w * h; i++) {
    m[i] = near[i] && glyphColor(ref[3 * i], ref[3 * i + 1]) && luma(ref[3 * i], ref[3 * i + 1], ref[3 * i + 2]) - luma(bg[3 * i], bg[3 * i + 1], bg[3 * i + 2]) > -12 ? 1 : 0;
  }
  return open3(m, w, h);
}
// the pieces of a mask under minPx pixels removed (4-connected): specks where the background fit misses
function dropSpecks(m, w, minPx) {
  const seen = new Uint8Array(m.length), out = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) {
    if (!m[i] || seen[i]) continue;
    const stack = [i], piece = [];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop(), x = j % w;
      piece.push(j);
      for (const n of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, j - w, j + w]) if (n >= 0 && n < m.length && m[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
    }
    if (piece.length >= minPx) for (const j of piece) out[j] = 1;
  }
  return out;
}

// text lines of a mask: runs of rows with 6+ glyph pixels (12+ rows tall), each trimmed to the rows
// holding a quarter of its busiest row — cap top to baseline, without accents and commas
function lineRuns(m, w, h) {
  const rows = new Int32Array(h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) rows[y]++;
  const runs = [];
  for (let y = 0; y < h; y++) if (rows[y] >= 6) { const last = runs.at(-1); if (last && y - last[1] <= 3) last[1] = y; else runs.push([y, y]); }
  return runs.filter(([a, b]) => b - a >= 11).map(([a, b]) => {
    const q = Math.max(...rows.slice(a, b + 1)) / 4;
    while (rows[a] < q) a++;
    while (rows[b] < q) b--;
    return [a, b];
  });
}
// per column of a line: the distance (px) to the nearest column where `m` has glyph pixels
function columnDistance(m, w, [a, b]) {
  const d = new Float64Array(w);
  let last = -Infinity;
  for (let x = 0; x < w; x++) { for (let y = a; y <= b; y++) if (m[y * w + x]) { last = x; break; } d[x] = x - last; }
  last = Infinity;
  for (let x = w - 1; x >= 0; x--) { for (let y = a; y <= b; y++) if (m[y * w + x]) { last = x; break; } d[x] = Math.min(d[x], last - x); }
  return d;
}
// cap height of one color inside a line: from the first to the last row holding 30 % of its busiest row
function capHeight(m, w, [a, b], cls) {
  const rows = [];
  for (let y = Math.max(0, a - 4); y <= b + 4; y++) { let n = 0; for (let x = 0; x < w; x++) if (m[y * w + x] === cls) n++; rows.push([y, n]); }
  const max = Math.max(...rows.map(([, n]) => n));
  if (max < 12) return null;
  const on = rows.filter(([, n]) => n >= 0.3 * max);
  return on.at(-1)[0] - on[0][0] + 1;
}
// two glyph masks with a 1 px boundary tolerance: the share of both masks' pixels within 1 px of the
// other (1 = the same glyphs), best over ±shift px. A plain IoU is ruled by the 1 px rim that the
// reference's compression takes off 7 px strokes (0.75–0.9 on a matching page); this is not
function glyphMatch(A, B, w, h, shift) {
  const dA = square(A, w, h, true), dB = square(B, w, h, true);
  let best = 0;
  for (let dy = -shift; dy <= shift; dy++) for (let dx = -shift; dx <= shift; dx++) {
    let hit = 0, n = 0;
    for (let y = Math.max(0, -dy); y < Math.min(h, h - dy); y++) for (let x = Math.max(0, -dx); x < Math.min(w, w - dx); x++) {
      const i = y * w + x, j = i + dy * w + dx;
      if (A[i]) { n++; if (dB[j]) hit++; }
      if (B[j]) { n++; if (dA[i]) hit++; }
    }
    best = Math.max(best, n ? hit / n : 0);
  }
  return best;
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

// the expected pages as caption data (the golden's own wording, tiers and times)
export function expectedCaptions(words, exp) {
  const preset = presetOf(exp.pack);
  const at = new Map(words.map((w, i) => [w.wid, i]));
  return exp.pages.map((e, k) => {
    const shown = e.text.split(' ');
    const ws = words.slice(at.get(e.wids[0]), at.get(e.wids[1]) + 1);
    if (ws.length !== shown.length) throw new Error(`P${k + 1}: ${ws.length} words for "${e.text}"`);
    const cw = ws.map((w, j) => ({wid: w.wid, text: shown[j], startMs: w.startMs, endMs: w.endMs, tier: e.yellow.includes(w.wid) ? 1 : 0}));
    return {id: `g${k}`, src: exp.source, words: cw, startMs: cw[0].startMs, endMs: cw.at(-1).endMs, topPct: preset.layout.topPct ?? DEFAULT_TOP};
  });
}

export async function layerB(dir, words, exp, {keep = false, log = console.log} = {}) {
  const {width: w, height: h, frameOffset: off} = exp;
  const y0 = Math.max(0, exp.capTop - 60), bh = Math.min(h - y0, 280), band = {w, h, y0, bh};
  const captions = expectedCaptions(words, exp);
  const clip = {id: 'golden', src: exp.source, label: 'golden', inSec: 0, outSec: exp.sourceSec, sourceDurationSec: exp.sourceSec};
  const props = {...projectRenderProps({clips: [clip], captions, captionStyle: exp.pack}), layer: 'captions'};
  // Remotion reads a dot in a sequence folder's path as an extension: the OS temp dir, as render-runner
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-golden-'));
  try {
    fs.writeFileSync(path.join(tmp, 'props.json'), JSON.stringify(props));
    log(`rendering the caption layer at ${w}×${h}…`);
    const r = spawnSync('npx', ['remotion', 'render', 'MultiClip', path.join(tmp, 'frames'), `--props=${path.join(tmp, 'props.json')}`, `--scale=${w / 1080}`, '--sequence', '--image-format=png', '--muted', '--log=error'], {cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit']});
    if (r.status !== 0) throw new Error('the render failed');
    const frames = fs.readdirSync(path.join(tmp, 'frames')).filter((f) => f.endsWith('.png')).sort().map((f) => path.join(tmp, 'frames', f));
    const crop = ['-vf', `crop=${w}:${bh}:0:${y0}`, '-pix_fmt', 'rgba'];
    const ours = [];
    await decode(['-framerate', String(FPS), '-pattern_type', 'glob', '-i', path.join(tmp, 'frames', '*.png'), ...crop], w * bh * 4, (b) => ours.push(ourClasses(b, w, bh)));

    const rows = [], settled = [];
    const from = captions.map((c) => Math.round((c.startMs / 1000) * FPS));
    exp.pages.forEach((e, k) => {
      const page = `P${k + 1}`, end = k + 1 < from.length ? from[k + 1] - 1 : ours.length - 1;
      const vis = [];
      for (let t = from[k]; t <= end; t++) if (ours[t]?.seen >= 150) vis.push(t);
      if (!vis.length) { rows.push({page, check: 'shown', ok: false, got: 'never', want: `${e.refFirst}–${e.refLast}`}); return; }
      const first = vis[0] - off, last = vis.at(-1) - off;
      rows.push({page, check: 'first', ok: Math.abs(first - e.refFirst) <= TOL.frames, got: first, want: e.refFirst});
      rows.push({page, check: 'last', ok: Math.abs(last - e.refLast) <= TOL.frames, got: last, want: e.refLast});
      // settled: our page's last frame against the reference's (the timing is checked above)
      const s = vis.at(-1), m = ours[s].core, lines = lineRuns(m, w, bh);
      const top = lines.length ? lines[0][0] + y0 : null;
      rows.push({page, check: 'cap top', ok: top != null && Math.abs(top - exp.capTop) <= TOL.capTopPx, got: top, want: exp.capTop});
      // from the first frame on, every glyph column of a line lies on a column the settled line uses
      const dist = lines.map((l) => columnDistance(m, w, l));
      let drift = 0, at = null;
      for (let t = vis[0]; t <= s; t++) lines.forEach(([a, b], i) => {
        for (let x = 0; x < w; x++) for (let y = a; y <= b; y++) if (ours[t].core[y * w + x]) { if (dist[i][x] > drift) { drift = dist[i][x]; at = t - off; } break; }
      });
      rows.push({page, check: 'no recenter', ok: drift <= TOL.shiftPx, got: drift ? `${drift} px off at f${at}` : '0 px', want: `≤ ${TOL.shiftPx} px`});
      settled.push({page, t: s, ref: e.refLast, lines});
    });

    // the reference at those frames, over its own background (the source frame it shows, color-fit)
    const refFrames = await framesAt(path.join(dir, 'ref.mp4'), settled.map((x) => x.ref), band);
    const srcFrames = await framesAt(path.join(ROOT, 'public', exp.source), settled.flatMap((x) => [x.ref, x.ref + 1]), band);
    const fitRows = [...Array(bh).keys()].filter((y) => y < 30 || y >= bh - 35);
    const heights = {1: [], 2: []};
    for (const x of settled) {
      const ref = refFrames.get(x.ref);
      const fits = [x.ref, x.ref + 1].filter((n) => srcFrames.has(n)).map((n) => ({n, fit: fitGrade(srcFrames.get(n), ref, w, fitRows)})).sort((a, b) => a.fit.residual - b.fit.residual);
      // both masks around our text only (±24 px), background specks out
      const O = ours[x.t].core, box = new Uint8Array(w * bh);
      let [x0, x1, ya, yb] = [w, -1, bh, -1];
      for (let i = 0; i < O.length; i++) if (O[i]) { const y = (i / w) | 0, xx = i % w; x0 = Math.min(x0, xx); x1 = Math.max(x1, xx); ya = Math.min(ya, y); yb = Math.max(yb, y); }
      for (let y = Math.max(0, ya - 24); y <= Math.min(bh - 1, yb + 24); y++) for (let xx = Math.max(0, x0 - 24); xx <= Math.min(w - 1, x1 + 24); xx++) box[y * w + xx] = 1;
      const R = refCore(ref, srcFrames.get(fits[0].n), w, bh, fits[0].fit);
      const score = glyphMatch(dropSpecks(O.map((v, i) => (box[i] ? v : 0)), w, 40), dropSpecks(R.map((v, i) => (box[i] ? v : 0)), w, 40), w, bh, TOL.shiftPx);
      rows.push({page: x.page, check: 'glyphs', ok: score >= TOL.match, got: score.toFixed(3), want: `≥ ${TOL.match}`});
      let edge;
      await decode(['-i', frames[x.t], ...crop], w * bh * 4, (b) => (edge = ourClasses(b, w, bh, 128).core));
      for (const l of x.lines) for (const cls of [1, 2]) { const hh = capHeight(edge, w, l, cls); if (hh) heights[cls].push(hh); }
    }
    const ratio = heights[1].length && heights[2].length ? median(heights[2]) / median(heights[1]) : null;
    rows.push({page: '*', check: 'yellow/white', ok: ratio != null && ratio >= TOL.ratio[0] && ratio <= TOL.ratio[1], got: ratio?.toFixed(3) ?? 'no pair', want: TOL.ratio.join('–')});
    return rows;
  } finally {
    if (!keep) fs.rmSync(tmp, {recursive: true, force: true});
    else log(`frames kept in ${tmp}`);
  }
}

// ---------- the table ----------
export function table(title, rows) {
  const out = [`${title}: ${rows.every((r) => r.ok) ? 'PASS' : 'FAIL'} (${rows.filter((r) => r.ok).length}/${rows.length} checks)`];
  const pages = [...new Set(rows.map((r) => r.page))];
  for (const p of pages) {
    const rs = rows.filter((r) => r.page === p);
    out.push(`  ${p.padEnd(4)} ${rs.map((r) => `${r.check} ${r.ok ? 'ok' : 'FAIL'}${r.got != null && (!r.ok || typeof r.got === 'number' || /glyphs|recenter|yellow/.test(r.check)) ? ` (${r.got}${r.ok ? '' : ` vs ${r.want}`})` : ''}`).join('  ')}`);
  }
  return out.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [arg, ...flags] = process.argv.slice(2);
  if (!arg) { console.error('usage: npm run golden <name|dir> [-- --a | --b]'); process.exit(2); }
  const dir = fs.existsSync(arg) ? path.resolve(arg) : path.join(ROOT, 'public', 'goldens', arg);
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const words = read('words.json'), exp = read('expected.json');
  const preset = presetOf(exp.pack);
  const fontFile = preset.font.custom && path.join(ROOT, 'public', preset.font.custom.file);
  const measure = fontFile && fs.existsSync(fontFile) ? fontAdvances(fontFile) : null;
  if (measure) realAdvances(preset.font.custom.family, measure); // the page size as the renderer fits it
  let ok = true;
  if (!flags.includes('--b')) {
    const rows = layerA(words, exp, {measure});
    console.log(table(`Layer A — ${path.basename(dir)}, pack ${exp.pack}${measure ? '' : ' (lines~ = width estimate: the pack\'s font file is missing)'}`, rows));
    ok &&= rows.every((r) => r.ok);
  }
  if (!flags.includes('--a')) {
    const rows = await layerB(dir, words, exp, {keep: flags.includes('--keep')});
    console.log(table(`Layer B — ${exp.width}×${exp.height} against ref.mp4 (frames in ref time)`, rows));
    ok &&= rows.every((r) => r.ok);
  }
  process.exit(ok ? 0 : 1);
}
