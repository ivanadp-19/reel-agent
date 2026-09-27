import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {CLEAN, WIND, windIssues, windOf, windy} from '../src/audio.ts';
import {readWind, scanWind} from '../scripts/wind-scan.mjs';

const tmps = [];
after(() => { for (const d of tmps) fs.rmSync(d, {recursive: true, force: true}); });
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

// a scan of `sec` seconds: `floor` dB in the pauses with its band under 150 Hz `share` dB under it, a voice at −15 dB where words are
const words = [[500, 2000], [3000, 4500], [6000, 7500]].map(([startMs, endMs]) => ({startMs, endMs}));
function scan(floor, share, sec = 9) {
  const t = (k) => (k + 0.5) * 100, inWord = (k) => words.some((w) => t(k) >= w.startMs && t(k) < w.endMs);
  const full = Array.from({length: sec * WIND.fps}, (_, k) => (inWord(k) ? -15 : floor + (k % 3))); // a little movement
  return {fps: WIND.fps, full, low: full.map((x, k) => (inWord(k) ? -30 : x + share))};
}
test('wind: a loud floor under 150 Hz in the pauses of the take; not a quiet room with rumble, not a loud mid-band floor', () => {
  assert.ok(windy(windOf(scan(-25, -0.5), words)));
  assert.ok(!windy(windOf(scan(-52, -0.5), words))); // HVAC rumble: the floor is quiet
  assert.ok(!windy(windOf(scan(-30, -11), words))); // an outdoor take whose floor is mostly above 150 Hz
  assert.equal(windOf(scan(-25, -0.5), [{startMs: 0, endMs: 1000}, {startMs: 1300, endMs: 9000}]), null); // under a second of pause: nothing to tell
  assert.equal(windOf(scan(-25, -0.5), words.slice(0, 1)), null); // before the first word and after the last are not pauses (a slate, handling)
  assert.equal(windOf(scan(-25, -0.5), []), null);
});

test('wind: one warning per windy source the reel uses, naming the preset; never once the preset is on', () => {
  const clips = [{id: 'a', src: 'clips/a.mp4', inSec: 0, outSec: 9}, {id: 'b', src: 'clips/b.mp4', inSec: 0, outSec: 9}];
  const tr = {'clips/a.mp4': words, 'clips/b.mp4': words}; // what each whole source says
  const scans = {'clips/a.mp4': scan(-25, -0.5), 'clips/b.mp4': scan(-60, -12)};
  const w = windIssues({clips}, scans, tr);
  assert.deepEqual(w.map((i) => [i.level, i.code, i.ref]), [['warn', 'wind', 'a']]);
  assert.match(w[0].msg, /set_audio clean: wind/);
  assert.deepEqual(windIssues({clips, audio: {clean: 'wind'}}, scans, tr), []);
  assert.deepEqual(windIssues({clips}, {'clips/a.mp4': null, 'clips/b.mp4': {error: 'no audio', fps: 10, full: [], low: []}}, tr), []); // not scanned yet / no audio
  assert.match(CLEAN.wind.af, /^highpass=f=130:p=2,afftdn=/);
});

test('wind scan (ffmpeg): brown noise under 100 Hz beneath a voice fires, the same voice over quiet room tone does not; the preset takes the rumble down', {skip: !hasFfmpeg && 'ffmpeg not installed'}, async () => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-wind-'));
  tmps.push(pub);
  fs.mkdirSync(path.join(pub, 'clips'));
  const voice = "sine=f=220:d=9,volume='2*(between(t,0.5,2)+between(t,3,4.5)+between(t,6,7.5))':eval=frame";
  const make = (name, noise, af = '') => assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', voice, '-f', 'lavfi', '-i', noise, '-filter_complex', `[0][1]amix=inputs=2:normalize=0${af ? `,${af}` : ''}`, '-c:a', 'aac', path.join(pub, 'clips', name)]).status, 0);
  make('wind.m4a', 'anoisesrc=c=brown:a=0.5:d=9,lowpass=f=100,lowpass=f=100');
  make('calm.m4a', 'anoisesrc=c=pink:a=0.003:d=9');
  make('wind-clean.m4a', 'anoisesrc=c=brown:a=0.5:d=9,lowpass=f=100,lowpass=f=100', CLEAN.wind.af);
  const of = async (name) => windOf(await scanWind(pub, `clips/${name}`), words);
  const [wind, calm, cleaned] = [await of('wind.m4a'), await of('calm.m4a'), await of('wind-clean.m4a')];
  assert.ok(windy(wind), JSON.stringify(wind));
  assert.ok(!windy(calm), JSON.stringify(calm));
  assert.ok(cleaned.floorDb < wind.floorDb - 10, `${wind.floorDb} → ${cleaned.floorDb}`);
  // cached by path + size + mtime: current until the file changes
  assert.ok(Math.abs(readWind(pub, 'clips/wind.m4a').full.length - 90) <= 1); // 9 s in 100 ms windows (AAC adds a few ms)
  fs.appendFileSync(path.join(pub, 'clips', 'wind.m4a'), Buffer.alloc(16));
  assert.equal(readWind(pub, 'clips/wind.m4a'), null);
  assert.equal(readWind(pub, 'clips/none.m4a'), undefined);
});
