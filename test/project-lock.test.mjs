import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {LOCK_TTL_MS, acquireLock, releaseLock} from '../scripts/project-lock.mjs';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'locks-'));
const parent = process.ppid; // a live process that is not us

test('the first agent takes the lock, a second live one is refused, the holder can write again', () => {
  const d = dir();
  assert.ok(acquireLock(d, 'p-1', {pid: parent, owner: 'agent A'}).ok);
  const r = acquireLock(d, 'p-1', {owner: 'agent B'});
  assert.equal(r.ok, false);
  assert.equal(r.holder.owner, 'agent A');
  assert.ok(acquireLock(d, 'p-1', {pid: parent}).ok, 'the holder refreshes its own lock');
  assert.ok(acquireLock(d, 'p-2', {owner: 'agent B'}).ok, 'other projects are free');
});

test('a dead holder or a silent one past the TTL is taken over; release frees it', () => {
  const d = dir();
  const dead = spawnSync('true').pid; // exited already
  assert.ok(acquireLock(d, 'p', {pid: dead}).ok);
  assert.ok(acquireLock(d, 'p').ok, 'dead process → stale');
  const d2 = dir();
  assert.ok(acquireLock(d2, 'p', {pid: parent, now: Date.now() - LOCK_TTL_MS - 1}).ok);
  assert.ok(acquireLock(d2, 'p').ok, 'silent past the TTL → stale');
  releaseLock(d2, 'p');
  assert.ok(!fs.existsSync(path.join(d2, 'p.lock')));
  assert.ok(acquireLock(d2, 'p', {pid: parent}).ok);
  releaseLock(d2, 'p'); // not ours: stays
  assert.ok(fs.existsSync(path.join(d2, 'p.lock')));
});

test('sessions of one process (MCP over HTTP) are separate agents: each holds and frees only its own lock', () => {
  const d = dir();
  assert.ok(acquireLock(d, 'p', {owner: 'mcp http session a', session: 'a'}).ok);
  const r = acquireLock(d, 'p', {owner: 'mcp http session b', session: 'b'});
  assert.equal(r.ok, false, 'another session of the same process is refused');
  assert.equal(r.holder.owner, 'mcp http session a');
  assert.equal(acquireLock(d, 'p').ok, false, 'so is a caller with no session');
  assert.ok(acquireLock(d, 'p', {session: 'a'}).ok, 'the holding session refreshes it');
  releaseLock(d, 'p', process.pid, 'b');
  assert.ok(fs.existsSync(path.join(d, 'p.lock')), 'another session cannot free it');
  releaseLock(d, 'p', process.pid, 'a');
  assert.ok(acquireLock(d, 'p', {session: 'b'}).ok, 'freed when its session ends');
});
