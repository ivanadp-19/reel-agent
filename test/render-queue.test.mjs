import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createQueue, renderArgs, renderPlan} from '../scripts/render-queue.mjs';

const GB = 1e9;
test('render plan: the 2-vCPU VM renders one at a time with both cores; big boxes run several', () => {
  assert.deepEqual({...renderPlan({cpus: 2, memBytes: 8 * GB, env: {}}), cacheBytes: 0}, {workers: 1, concurrency: 2, cacheBytes: 0});
  const m = renderPlan({cpus: 16, memBytes: 64 * GB, env: {}});
  assert.equal(m.workers, 2); assert.equal(m.concurrency, 6);
  assert.equal(renderPlan({cpus: 32, memBytes: 4 * GB, env: {}}).workers, 1, 'RAM caps the workers');
  const o = renderPlan({cpus: 2, memBytes: 8 * GB, env: {REEL_RENDER_WORKERS: '2', REEL_RENDER_CONCURRENCY: '1'}});
  assert.equal(o.workers, 2); assert.equal(o.concurrency, 1);
});

test('render args: draft = half scale + ultrafast', () => {
  const a = renderArgs({outFile: 'o.mp4', propsFile: 'p.json', publicDir: 'pub', draft: true, concurrency: 2, cacheBytes: 5e8});
  assert.ok(a.includes('--scale=0.5') && a.includes('--x264-preset=ultrafast') && a.includes('--concurrency=2'));
  assert.ok(!renderArgs({outFile: 'o', propsFile: 'p', publicDir: 'x', draft: false, concurrency: 1, cacheBytes: 1}).includes('--scale=0.5'));
});

test('queue: N at once, FIFO, the rest wait and report how many are ahead', async () => {
  const started = [], done = {};
  const gates = {};
  const q = createQueue(2, (job, id) => { started.push(id); return new Promise((r) => { gates[id] = r; }).then(() => { done[id] = true; }); });
  assert.equal(q.push('a'), 0); assert.equal(q.push('b'), 0);
  assert.equal(q.push('c'), 1); assert.equal(q.push('d'), 2);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(started, ['a', 'b']);
  gates.a(); await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(started, ['a', 'b', 'c']); assert.equal(q.ahead('d'), 1);
  // a failing job frees its slot too
  const q2 = createQueue(1, (job) => (job === 'bad' ? Promise.reject(new Error('x')) : Promise.resolve()));
  q2.push('1', 'bad'); q2.push('2', 'ok');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(q2.running, 0); assert.equal(q2.waiting, 0);
});
