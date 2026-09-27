#!/usr/bin/env node
// Wind on a source's audio (T16; OQ4: ffmpeg only, no model). One pass over the audio: per 100 ms window the RMS
// of the whole band and of the band under 150 Hz (lowpass=f=150 twice, as the render judge splits its bands),
// niced, one thread, cached by path + size + mtime in public/clips/wind-scan/<its path under public/>.json (the
// grade scan's pattern). The rule that reads it — the pauses without speech, the floor there and how much of it
// sits under 150 Hz — is pure and shared: src/audio.ts windIssues (validate, the editor's Validate). The backend
// runs the scan in the grade scan's background lane (after an ingest, and for the sources a validate finds
// unscanned) — never inside a request; on demand:
//   node scripts/wind-scan.mjs <file under public/ or absolute> … [--force] [--json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {WIND} from '../src/audio.ts';

export const WIND_VERSION = 1;
const RATE = 16000, WIN = RATE / WIND.fps;
const NICE = () => Number(process.env.REEL_GRADE_SCAN_NICE ?? 15);
const TIMEOUT = () => Number(process.env.REEL_GRADE_SCAN_TIMEOUT_MS || 600000);
const fileOf = (publicDir, src) => (path.isAbsolute(src) ? src : path.join(publicDir, src.replace(/^\//, '')));
const relOf = (publicDir, src) => path.relative(publicDir, fileOf(publicDir, src));
export const windFile = (publicDir, src) => path.join(publicDir, 'clips', 'wind-scan', `${relOf(publicDir, src).replace(/[^\w.-]+/g, '_')}.json`);
const keyOf = (file) => { const st = fs.statSync(file); return {size: st.size, mtimeMs: Math.round(st.mtimeMs)}; };

// the cached scan while it is current (same path, size + mtime), else null; undefined = no such file
export function readWind(publicDir, src) {
  const file = fileOf(publicDir, src);
  if (!fs.existsSync(file)) return undefined;
  try {
    const e = JSON.parse(fs.readFileSync(windFile(publicDir, src), 'utf8')), k = keyOf(file);
    return e.version === WIND_VERSION && e.src === relOf(publicDir, src) && e.size === k.size && e.mtimeMs === k.mtimeMs ? e : null;
  } catch { return null; }
}

const db = (sum, n) => Math.round(10 * Math.log10(sum / n + 1e-18) * 10) / 10; // RMS in dBFS (10·log10 of the mean square)
// the audio, mono 16 kHz, as two channels (whole band, under 150 Hz) → {full, low} dB per window, summed as it streams
function measure(file, name) {
  return new Promise((resolve, reject) => {
    const g = '[0:a:0]aresample=16000,aformat=channel_layouts=mono,asplit[f][l];[l]lowpass=f=150,lowpass=f=150[lo];[f][lo]amerge=inputs=2[o]';
    const c = spawn('ffmpeg', ['-hide_banner', '-v', 'error', '-threads', '1', '-i', file, '-vn', '-filter_complex', g, '-map', '[o]', '-f', 'f32le', '-']);
    try { if (NICE() > 0) os.setPriority(c.pid, Math.min(19, NICE())); } catch {}
    const full = [], low = [];
    let f = 0, l = 0, n = 0, rest = Buffer.alloc(0), err = '';
    const timer = setTimeout(() => c.kill('SIGKILL'), TIMEOUT());
    c.stdout.on('data', (d) => {
      const buf = Buffer.concat([rest, d]), whole = buf.length - (buf.length % 8);
      for (let o = 0; o < whole; o += 8) {
        const a = buf.readFloatLE(o), b = buf.readFloatLE(o + 4);
        f += a * a; l += b * b;
        if (++n === WIN) { full.push(db(f, n)); low.push(db(l, n)); f = l = n = 0; }
      }
      rest = buf.subarray(whole);
    });
    c.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    const fail = (msg, retry) => reject(Object.assign(new Error(`wind scan of ${name}${msg}`), {retry}));
    c.on('error', (e) => { clearTimeout(timer); fail(`: ${e.code ?? e.message}`, true); });
    c.on('close', (code, sig) => {
      clearTimeout(timer);
      if (n) { full.push(db(f, n)); low.push(db(l, n)); }
      code === 0 ? resolve({full, low}) : sig ? fail(` stopped (${sig}: over ${TIMEOUT() / 1000} s?)`, true) : fail(`: ${err.trim().split('\n').pop()?.split(file).join(name) || `ffmpeg exit ${code}`}`, false);
    });
  });
}

// scan one source (cached): {version, src, size, mtimeMs, fps, full, low}. A file with no audio (or one that does not
// decode) is cached as {error}: not decoded again on every validate (--force retries)
export async function scanWind(publicDir, src, {force = false} = {}) {
  const hit = !force && readWind(publicDir, src);
  if (hit) return hit;
  const file = fileOf(publicDir, src), k = keyOf(file);
  const save = (e) => {
    const entry = {version: WIND_VERSION, src: relOf(publicDir, src), ...k, fps: WIND.fps, ...e, scannedAt: new Date().toISOString()};
    const out = windFile(publicDir, src), tmp = `${out}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(out), {recursive: true});
    fs.writeFileSync(tmp, JSON.stringify(entry));
    fs.renameSync(tmp, out);
    return entry;
  };
  try { return save(await measure(file, relOf(publicDir, src))); } catch (e) { if (!e.retry) save({error: String(e?.message ?? e).slice(0, 300), full: [], low: []}); throw e; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), force = args.includes('--force'), asJson = args.includes('--json');
  const publicDir = path.resolve(import.meta.dirname, '..', 'public');
  try { if (NICE() > 0) os.setPriority(0, Math.min(19, NICE())); } catch {}
  const srcs = args.filter((a) => !a.startsWith('--'));
  if (!srcs.length) { console.error('usage: node scripts/wind-scan.mjs <file under public/ or absolute> … [--force] [--json]'); process.exit(2); }
  const all = [];
  for (const src of srcs) {
    const e = await scanWind(publicDir, path.isAbsolute(src) || !src.startsWith('public/') ? src : src.slice(7), {force});
    all.push(e);
    if (!asJson) console.log(`${src}: ${(e.full.length / e.fps).toFixed(1)} s scanned`);
  }
  if (asJson) console.log(JSON.stringify(all));
}
