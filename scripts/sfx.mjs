// Sound effects synthesized with ffmpeg (noise, sines, envelopes): nothing to
// license, nothing to download. Generated once into public/sfx/ on demand.
//   whoosh — filtered pink noise with a fast swell, for whip / zoom cuts
//   thud   — low sine drop, for a hard punch-in
//   pop    — short tone blip, for stickers and starbursts
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIR = path.join(ROOT, 'public', 'sfx');
export const SFX = {
  whoosh: 'anoisesrc=d=0.5:c=pink:a=0.8:r=48000,highpass=f=500,lowpass=f=7000,afade=t=in:d=0.14:curve=qsin,afade=t=out:st=0.22:d=0.28:curve=qsin,volume=1.6',
  thud: 'sine=f=80:d=0.3:r=48000,afade=t=out:st=0.02:d=0.28:curve=exp,lowpass=f=160,volume=2.2',
  pop: 'sine=f=900:d=0.09:r=48000,afade=t=out:st=0.01:d=0.08:curve=exp,volume=1.2',
};
export function ensureSfx() {
  fs.mkdirSync(DIR, {recursive: true});
  for (const [name, graph] of Object.entries(SFX)) {
    const f = path.join(DIR, `${name}.wav`);
    if (fs.existsSync(f)) continue;
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', graph, '-ac', '2', f]);
    if (r.status !== 0) throw new Error(`sfx ${name}: ${r.stderr.toString().trim().split('\n').pop()}`);
  }
  return DIR;
}
if (import.meta.url === `file://${process.argv[1]}`) console.log(ensureSfx());
