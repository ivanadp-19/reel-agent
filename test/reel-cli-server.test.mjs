// The backend pieces behind the reel CLI (cli/reel.mjs): per-user tokens and the gate,
// what a user token may ingest by path, resumable upload parts, render admission (one
// per user, resource floors) and the render plan (complete or layers, and why).
import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {createTokenStore, openForUser} from '../server/tokens.mjs';
import {gate} from '../server/http.mjs';
import {appendChunk, partFile, partSize, sweepParts} from '../server/uploads.mjs';
import {admitRender, propsHash} from '../scripts/render-jobs.mjs';
import {planRender} from '../scripts/render-runner.mjs';
import {localBrollName} from '../scripts/remote-broll.mjs';

const tmps = [];
const tmpdir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-cli-srv-')); tmps.push(d); return d; };
after(() => { for (const d of tmps) fs.rmSync(d, {recursive: true, force: true}); });

test('tokens: shown once, stored as sha256 in a 0600 file, found in constant time, revoked by id or user', () => {
  const file = path.join(tmpdir(), 'tokens.json');
  const users = createTokenStore(file);
  const a = users.create({user: 'ana', uid: 1001});
  const b = users.create({user: 'bo', admin: true});
  assert.match(a.token, /^reel_[\w-]{32}$/);
  const disk = fs.readFileSync(file, 'utf8');
  assert.ok(!disk.includes(a.token) && !disk.includes(b.token), 'no secret on disk');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual({user: users.find(a.token).user, uid: users.find(a.token).uid, admin: users.find(b.token).admin}, {user: 'ana', uid: 1001, admin: true});
  assert.equal(users.find(a.token).hash, undefined, 'the hash never leaves the store');
  assert.equal(users.find('reel_nope'), null);
  assert.equal(users.find('not-a-user-token'), null);
  assert.ok(users.list().every((t) => !('hash' in t) && !('token' in t)));
  assert.throws(() => users.create({user: '../etc'}), /user:/);
  assert.deepEqual(users.revoke('ana'), [a.id]);
  assert.equal(users.find(a.token), null);
  assert.deepEqual(users.revoke('ana'), [], 'revoking again is a no-op');
  assert.deepEqual(users.revoke(b.id), [b.id]);
  // another process (a second backend on the same file) sees the change
  assert.equal(createTokenStore(file).find(b.token), null);
});

test('gate: user tokens name the caller in both modes; a revoked one is refused on loopback too; REEL_REQUIRE_TOKEN closes anonymous loopback', async () => {
  const users = createTokenStore(path.join(tmpdir(), 't.json'));
  const {token} = users.create({user: 'ana', uid: 7});
  const call = (headers, opts, route = '/api/projects') => gate({method: 'GET', headers: {host: '127.0.0.1:3333', ...headers}}, new URL(`http://x${route}`), {tokens: ['backend-tok'], users, ...opts});
  assert.deepEqual(await call({'x-reel-token': token}, {publicMode: false}), {kind: 'ok', user: 'ana', admin: false, uid: 7, via: 'user-token'});
  assert.equal((await call({'x-reel-token': token}, {publicMode: true})).user, 'ana');
  assert.deepEqual(await call({'x-reel-token': 'backend-tok'}, {publicMode: false}), {kind: 'ok', admin: true, via: 'backend-token'});
  assert.deepEqual(await call({}, {publicMode: false}), {kind: 'ok', via: 'loopback'}, 'the editor and the MCP on loopback work as before');
  assert.deepEqual(await call({'x-reel-token': 'stale-backend-token'}, {publicMode: false}), {kind: 'ok', via: 'loopback'}, 'an old backend token is ignored as before');
  const req = await call({}, {publicMode: false, requireToken: true});
  assert.equal(req.status, 401);
  assert.equal(JSON.parse(req.body).code, 'token_required');
  assert.equal((await call({}, {publicMode: false, requireToken: true}, '/r/abc')).kind, 'review', 'review pages stay public');
  users.revoke('ana');
  for (const publicMode of [false, true]) {
    const d = await call({'x-reel-token': token}, {publicMode});
    assert.equal(d.status, 401);
    assert.equal(JSON.parse(d.body).code, 'bad_token');
  }
  // a token never opens the loopback gate to another Host (DNS rebinding)
  assert.equal((await gate({headers: {host: 'evil.example', 'x-reel-token': 'backend-tok'}}, new URL('http://x/api/projects'), {publicMode: false, tokens: ['backend-tok'], users})).status, 403);
});

test('openForUser: own files, or files anyone can read down traversable folders — never another user\'s private file', () => {
  const dir = tmpdir();
  fs.chmodSync(dir, 0o755);
  const f = path.join(dir, 'take.mp4');
  fs.writeFileSync(f, 'video');
  const me = process.getuid();
  const other = me + 12345;
  const open = (file, uid) => { const o = openForUser(file, uid); o?.close(); return !!o; };
  assert.ok(open(f, me), 'the token user owns it');
  fs.chmodSync(f, 0o600);
  assert.ok(!open(f, other), 'private file of someone else');
  fs.chmodSync(f, 0o644);
  const ancestorsOpen = path.dirname(fs.realpathSync(dir)).split(path.sep).reduce((acc, _, i, parts) => acc && (i === 0 || !!(fs.statSync(parts.slice(0, i + 1).join(path.sep) || '/').mode & 0o001)), true);
  assert.equal(open(f, other), ancestorsOpen, 'world-readable file: readable only if every folder above lets anyone through');
  fs.chmodSync(dir, 0o700);
  assert.ok(!open(f, other), 'world-readable file inside a private folder');
  fs.chmodSync(dir, 0o755);
  assert.ok(!open(path.join(dir, 'missing.mp4'), me));
  assert.ok(!open(dir, me), 'not a regular file');
  const link = path.join(dir, 'link.mp4');
  fs.symlinkSync(f, link);
  fs.chmodSync(f, 0o600);
  assert.ok(!open(link, other), 'a symlink is judged by what it points at');
  if (spawnSync('mkfifo', [path.join(dir, 'fifo.mp4')]).status === 0) assert.ok(!open(path.join(dir, 'fifo.mp4'), me), 'a FIFO neither hangs nor passes');
  if (process.platform === 'linux') {
    const o = openForUser(f, me);
    assert.match(o.path, new RegExp(`^/proc/${process.pid}/fd/\\d+$`), 'ffmpeg reads the checked descriptor, not the path');
    o.close();
  }
});

const chunk = (bytes) => Object.assign(Readable.from([Buffer.from(bytes)]), {headers: {'content-length': String(Buffer.byteLength(bytes))}});
test('uploads: chunks append only where the part ends; a retry of a landed chunk gets the size to resume from', async () => {
  const dir = tmpdir();
  const file = partFile(dir, 'ana', 'a'.repeat(32));
  assert.equal(path.basename(partFile(dir, '../x', 'b'.repeat(16))), '.._x-bbbbbbbbbbbbbbbb.part', 'no path out of the uploads folder');
  assert.deepEqual(await appendChunk(chunk('hello '), file, 0, {maxBytes: 100}), [200, {size: 6}]);
  const [st, again] = await appendChunk(chunk('hello '), file, 0, {maxBytes: 100});
  assert.equal(st, 409);
  assert.equal(again.size, 6);
  assert.deepEqual(await appendChunk(chunk('world'), file, 6, {maxBytes: 100}), [200, {size: 11}]);
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello world');
  assert.equal((await appendChunk(chunk('x'.repeat(95)), file, 11, {maxBytes: 100}))[0], 413);
  assert.equal((await appendChunk(chunk('xyz'), file, 11, {maxBytes: 100, freeBytes: 10, minFreeBytes: 8}))[0], 507);
  assert.equal((await appendChunk(Object.assign(Readable.from([]), {headers: {}}), file, 11, {maxBytes: 100}))[0], 411);
  fs.utimesSync(file, new Date(0), new Date(0));
  sweepParts(dir);
  assert.equal(partSize(file), 0, 'a part left for a day is swept');
});

test('admitRender: one render per user, a retry of the same one gets it back, floors of disk and memory', () => {
  const props = JSON.stringify({clips: [{id: 'a'}]});
  const mine = {id: 'j1', user: 'ana', status: 'running', propsHash: propsHash(props, 'layers')};
  const floors = {freeMemMb: 4000, freeDiskMb: 9000, minMemMb: 1024, minDiskMb: 3072};
  assert.equal(admitRender([mine], {user: 'ana', props, mode: 'layers'}, floors).reuse, mine);
  const busy = admitRender([mine], {user: 'ana', props: JSON.stringify({clips: []}), mode: 'layers'}, floors);
  assert.deepEqual([busy.status, busy.code, busy.jobId], [409, 'render_busy', 'j1']);
  assert.equal(admitRender([mine], {user: 'ana', props, mode: 'full'}, floors).code, 'render_busy', 'another mode is another render');
  assert.equal(admitRender([{...mine, status: 'done'}], {user: 'ana', props, mode: 'layers'}, floors), null);
  assert.equal(admitRender([mine], {user: 'bo', props, mode: 'layers'}, floors), null, 'other users queue behind');
  assert.equal(admitRender([mine], {user: null, props, mode: 'layers'}, floors), null, 'the editor / MCP (no user token) are not limited per user');
  assert.equal(admitRender([], {user: 'ana', props}, {...floors, freeDiskMb: 1000}).code, 'low_disk');
  assert.equal(admitRender([], {user: 'ana', props}, {...floors, freeMemMb: 500}).code, 'low_memory');
  assert.equal(admitRender([{id: 'x', status: 'running'}], {user: 'ana', props}, {...floors, freeMemMb: 500}), null, 'memory of a running render frees before a queued one starts');
  assert.equal(admitRender([], {user: 'ana', props}, {...floors, freeMemMb: null, minDiskMb: 0, freeDiskMb: 1}), null, 'unmeasured or turned off');
});

test('planRender: full mode, layer blockers, cached master, B-roll downloads still to do', () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, 'masters'));
  const masterCache = {file: (k) => path.join(dir, 'masters', `${k}.mp4`)};
  const keyOf = (p) => (p.brolls?.[0]?.src ?? 'k').replace(/\W/g, '_');
  const base = {clips: [{id: 'a', src: 'clips/a.mp4', inSec: 0, outSec: 3}], captions: [{id: 'c0', src: 'clips/a.mp4', startMs: 0, endMs: 900, topPct: 62, words: [{text: 'hola', startMs: 0, endMs: 900}]}], captionStyle: 'palabra'};
  const plan = (props, o = {}) => planRender(props, {requested: 'layers', publicDir: dir, masterCache, keyOf, ...o});
  assert.deepEqual([planRender(base, {requested: 'full'}).full, planRender(base, {requested: 'full'}).mode], [true, 'full']);
  const behind = plan({...base, captions: [{...base.captions[0], behind: true}]});
  assert.equal(behind.mode, 'full');
  assert.match(behind.reasons[0], /behind the presenter/);
  assert.match(plan(base).reasons[0], /no cached master/);
  fs.writeFileSync(masterCache.file('k'), '');
  assert.deepEqual(plan(base), {mode: 'layers', full: false, master: 'cached', captions: true, reasons: []});
  const remote = {src: 'https://videos.pexels.com/v/1.mp4', kind: 'video'};
  assert.match(plan({...base, brolls: [remote]}).reasons[0], /download/);
  fs.mkdirSync(path.join(dir, 'broll'));
  fs.writeFileSync(path.join(dir, 'broll', localBrollName(remote)), 'x');
  fs.writeFileSync(masterCache.file(keyOf({brolls: [{src: `broll/${localBrollName(remote)}`}]})), '');
  assert.equal(plan({...base, brolls: [remote]}).full, false, 'a downloaded B-roll is keyed under its local name, as the render will');
  assert.equal(plan(base, {masterCache: null}).full, true);
});
