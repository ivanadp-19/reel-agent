import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {availableMemMb, cgroupDirs, cgroupHeadroomMb, heapMb, memAvailableMb, oomKills, oomReason, renderEnv, signalCode, startMinMemMb} from '../scripts/render-memory.mjs';

const tmps = [];
after(() => { for (const d of tmps) fs.rmSync(d, {recursive: true, force: true}); });
const tmpdir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'render-memory-')); tmps.push(d); return d; };

test('heap cap: NODE_OPTIONS gets --max-old-space-size, an operator\'s options kept, their own cap wins; 0 turns it off', () => {
  assert.equal(heapMb({}), 1536);
  assert.equal(heapMb({REEL_RENDER_HEAP_MB: '2048'}), 2048);
  assert.equal(renderEnv({}).NODE_OPTIONS, '--max-old-space-size=1536');
  assert.equal(renderEnv({NODE_OPTIONS: '--enable-source-maps'}).NODE_OPTIONS, '--enable-source-maps --max-old-space-size=1536');
  assert.equal(renderEnv({NODE_OPTIONS: '--max-old-space-size=900'}).NODE_OPTIONS, '--max-old-space-size=900');
  assert.equal(renderEnv({REEL_RENDER_HEAP_MB: '0'}).NODE_OPTIONS, undefined);
  assert.equal(startMinMemMb({}), 2560);
  assert.equal(startMinMemMb({REEL_RENDER_START_MIN_MEM_MB: '0'}), 0);
});

test('OOM exits → an out-of-memory reason; other failures → null', () => {
  assert.match(oomReason({signal: 'SIGKILL'}), /^out of memory.*SIGKILL.*OOM killer/);
  assert.match(oomReason({code: 137}), /exit 137/);
  assert.match(oomReason({code: 134, tail: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'}), /heap limit \(--max-old-space-size=1536 MB/);
  assert.match(oomReason({code: null, signal: 'SIGKILL', what: 'Transcribe'}), /the Transcribe process was killed/);
  assert.match(oomReason({signal: 'SIGABRT'}), /SIGABRT/);
  assert.match(oomReason({code: 1, oomDelta: 1, tail: 'Target closed'}), /cgroup oom_kill \+1/);
  assert.equal(oomReason({code: 1, tail: 'Error: boom'}), null);
  assert.equal(oomReason({code: 0}), null);
  assert.equal(signalCode('SIGKILL'), 137);
  assert.equal(signalCode('SIGABRT'), 134);
});

test('available memory: MemAvailable, capped by the tightest cgroup limit (reclaimable page cache not counted)', () => {
  assert.equal(memAvailableMb('MemTotal: 32000000 kB\nMemFree: 1000 kB\nMemAvailable:   3145728 kB\n'), 3072);
  assert.equal(memAvailableMb('nothing'), null);
  const root = tmpdir();
  const self = path.join(root, 'cgroup');
  fs.writeFileSync(self, '0::/system.slice/reel-agent.service\n');
  const unit = path.join(root, 'system.slice', 'reel-agent.service');
  fs.mkdirSync(unit, {recursive: true});
  const dirs = cgroupDirs({procSelf: self, root});
  assert.deepEqual(dirs, [unit, path.join(root, 'system.slice')]);
  assert.equal(cgroupHeadroomMb(dirs), null, 'no memory files: no limit');
  fs.writeFileSync(path.join(root, 'system.slice', 'memory.max'), 'max\n');
  fs.writeFileSync(path.join(root, 'system.slice', 'memory.current'), String(10 * 2 ** 30));
  fs.writeFileSync(path.join(unit, 'memory.max'), String(4 * 2 ** 30));
  fs.writeFileSync(path.join(unit, 'memory.current'), String(3 * 2 ** 30));
  fs.writeFileSync(path.join(unit, 'memory.stat'), `anon 1\nfile ${2 ** 30 + 5}\nshmem 5\ninactive_file 7\n`);
  assert.equal(cgroupHeadroomMb(dirs), 2048); // 4 GB − (3 GB − 1 GB of page cache)
  const meminfo = () => `MemAvailable: ${20 * 2 ** 20} kB\n`;
  assert.equal(availableMemMb({meminfo, cgroup: () => cgroupHeadroomMb(dirs), platform: 'linux'}), 2048);
  assert.equal(availableMemMb({meminfo, cgroup: () => null, platform: 'linux'}), 20480);
  assert.equal(availableMemMb({meminfo, platform: 'darwin'}), null);
  fs.writeFileSync(path.join(unit, 'memory.events'), 'low 0\nhigh 0\nmax 3\noom 1\noom_kill 2\n');
  assert.equal(oomKills(dirs), 2);
  assert.equal(oomKills([]), null);
});

test('on this machine: available memory is a number on Linux', () => {
  const m = availableMemMb();
  if (process.platform === 'linux') assert.ok(m > 0);
  else assert.equal(m, null);
});
