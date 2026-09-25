import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {IDLE_MS, createToolClock, logTiming, readTiming, summarize, timingFile, timingText} from '../scripts/timing.mjs';

test('log: one JSON line per event next to the project, read back in order; bad ids never touch the disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timing-'));
  assert.ok(logTiming(dir, 'p-1', {kind: 'tool', tool: 'get_project', ms: 12}));
  assert.ok(logTiming(dir, 'p-1', {kind: 'stage', stage: 'render', ms: 9000}));
  assert.equal(timingFile(dir, 'p-1'), path.join(dir, 'p-1.timing.jsonl'));
  const ev = readTiming(dir, 'p-1');
  assert.deepEqual(ev.map((e) => e.tool ?? e.stage), ['get_project', 'render']);
  assert.ok(ev[0].t);
  assert.equal(logTiming(dir, '../escape', {kind: 'tool'}), false);
  assert.deepEqual(readTiming(dir, 'nothing-yet'), []);
  fs.appendFileSync(timingFile(dir, 'p-1'), '{broken\n');
  assert.equal(readTiming(dir, 'p-1').length, 2, 'a torn line is skipped');
  fs.rmSync(dir, {recursive: true, force: true});
});

test('clock: the gap between two calls is the agent turn; the first call has none; overlapping calls none', () => {
  let t = 0;
  const c = createToolClock(() => t);
  const a = c.start(); t = 50; assert.equal(c.end(a), 50);
  assert.equal(a.gapMs, null);
  t = 4050; const b = c.start(); assert.equal(b.gapMs, 4000);
  const p = c.start(); t = 4100; c.end(b); c.end(p);
  t = 4000; assert.equal(c.start().gapMs, 0);
});

test('summary: agent vs inspection vs backend stages, no double count of job waits, idle apart', () => {
  const ev = [
    {kind: 'tool', session: 's', tool: 'get_transcript', ms: 800, gapMs: null},
    {kind: 'tool', session: 's', tool: 'set_plan', ms: 40, gapMs: 30000},
    {kind: 'tool', session: 's', tool: 'caption_proof', ms: 9000, gapMs: 20000},
    {kind: 'tool', session: 's', tool: 'render', ms: 100500, jobMs: 100000, gapMs: 15000},
    {kind: 'stage', stage: 'master', ms: 60000, job: 'r1'},
    {kind: 'stage', stage: 'captions', ms: 25000, job: 'r1'},
    {kind: 'stage', stage: 'composite', ms: 5000, job: 'r1'},
    {kind: 'stage', stage: 'qc', ms: 10000},
    {kind: 'stage', stage: 'transcribe', ms: 45000},
    {kind: 'tool', session: 's', tool: 'edit_caption', ms: 30, gapMs: IDLE_MS + 1},
  ];
  const s = summarize(ev);
  assert.equal(s.buckets.agent, 65, 'three model turns');
  assert.equal(s.turns, 3);
  assert.equal(s.buckets.idle, +((IDLE_MS + 1) / 1000).toFixed(1));
  assert.equal(s.buckets.inspect, 9.8, 'caption_proof + get_transcript');
  assert.equal(s.buckets.render, 90);
  assert.deepEqual(s.renderStages, {master: 60, captions: 25, composite: 5});
  assert.equal(s.renders, 1);
  assert.equal(s.buckets.qc, 10);
  assert.equal(s.buckets.transcribe, 45);
  assert.equal(s.buckets.tools, 0.6, 'set_plan + edit_caption + the render call minus its job wait');
  assert.equal(s.biggest, 'render');
  assert.ok(Math.abs(Object.values(s.share).reduce((a, b) => a + b, 0) - 1) < 0.01);
  assert.match(timingText(s), /biggest: render/);
  assert.equal(s.tools.render.n, 1);
});

test('summary: an agent-bound project says so', () => {
  const ev = Array.from({length: 40}, (_, i) => ({kind: 'tool', session: 's', tool: 'edit_caption', ms: 50, gapMs: i ? 12000 : null}));
  ev.push({kind: 'stage', stage: 'render', ms: 120000});
  assert.equal(summarize(ev).biggest, 'agent');
  assert.equal(timingText(summarize([])), 'No timing logged for this project yet.');
});
