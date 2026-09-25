import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {localizeRemoteBrolls} from '../scripts/remote-broll.mjs';

const tmps = [];
const tmpdir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-broll-')); tmps.push(d); return d; };
after(() => { for (const d of tmps) fs.rmSync(d, {recursive: true, force: true}); });

// AbortSignal.timeout does not keep the loop alive (the backend always has something that does)
const alive = async (fn) => { const t = setInterval(() => {}, 1000); try { return await fn(); } finally { clearInterval(t); } };
const SRC = 'https://images.pexels.com/photos/1/pexels-photo-1.jpeg';
const props = (src = SRC) => ({brolls: [{id: 'b0', kind: 'image', src}]});
// a server that never answers (the fetch follows its signal, like undici's)
const neverAnswers = (u, {signal}) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason)));
// headers at once, then one chunk and nothing more (a stalled transfer)
const stallsMidBody = async () => new Response(new ReadableStream({start(c) { c.enqueue(new Uint8Array(1000)); }}), {status: 200});
// n MB in 64 KB chunks
const sends = (mb) => async () => new Response(new ReadableStream({
  start(c) { for (let i = 0; i < (mb * 1e6) / 65536; i++) c.enqueue(new Uint8Array(65536)); c.close(); },
}), {status: 200});

test('a download that never answers hits its deadline — no .part left, the props untouched', async () => {
  const dir = tmpdir();
  const p = props();
  const t = Date.now();
  await alive(() => assert.rejects(localizeRemoteBrolls(p, {dir, fetchImpl: neverAnswers, timeoutMs: 60}), /timed out after/));
  assert.ok(Date.now() - t < 2000);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(p.brolls[0].src, SRC);
});

test('a transfer that stalls mid-body hits the deadline too (the body read follows the signal)', async () => {
  const dir = tmpdir();
  await alive(() => assert.rejects(localizeRemoteBrolls(props(), {dir, fetchImpl: stallsMidBody, timeoutMs: 80}), /timed out/));
  assert.deepEqual(fs.readdirSync(dir), [], 'the half file is removed');
});

test('the job signal (cancel, stall control) stops a download at once', async () => {
  const dir = tmpdir();
  const ac = new AbortController();
  const why = Object.assign(new Error('cancelled by request'), {code: 'CANCELLED'});
  setTimeout(() => ac.abort(why), 30);
  const t = Date.now();
  await assert.rejects(localizeRemoteBrolls(props(), {dir, signal: ac.signal, fetchImpl: stallsMidBody, timeoutMs: 60e3}), (e) => e === why);
  assert.ok(Date.now() - t < 2000);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('progress per downloaded MB; the src is rewritten to the local copy; only Pexels', async () => {
  const dir = tmpdir();
  const seen = [];
  const p = props();
  await localizeRemoteBrolls(p, {dir, fetchImpl: sends(3), progress: (f, label) => seen.push(label)});
  assert.match(p.brolls[0].src, /^broll\/px-[0-9a-f]{16}\.jpeg$/);
  assert.ok(fs.statSync(path.join(dir, path.basename(p.brolls[0].src))).size > 3e6);
  assert.ok(['1 MB', '2 MB', '3 MB'].every((mb) => seen.some((l) => l.endsWith(mb))), seen.join(' | '));
  await assert.rejects(localizeRemoteBrolls(props('https://evil.example/x.jpg'), {dir, fetchImpl: sends(1)}), /only Pexels/);
});
