import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseProps, projectGraphics} from '../src/graphicTemplates.ts';
import {applyAutocut} from '../src/timeline.ts';

const clip = {id: 'a', src: 'clips/a.mp4', inSec: 0, outSec: 10, sourceDurationSec: 10};

test('parseProps fills defaults and rejects bad props with a readable message', () => {
  const ok = parseProps('hook-stack', {lines: [{text: 'Esto'}, {text: 'no es', accent: true}]});
  assert.deepEqual(ok, {lines: [{text: 'Esto', size: 'lg', accent: false}, {text: 'no es', size: 'lg', accent: true}], upper: false});
  assert.throws(() => parseProps('stat', {value: ''}), /stat: value/);
  assert.throws(() => parseProps('hook-stack', {lines: []}), /lines/);
});

test('a graphic follows its source through an autocut and is clipped at the cut', () => {
  const g = {id: 'g0', src: 'clips/a.mp4', startMs: 1000, endMs: 3000, template: 'stat', props: {value: '104 m²'}};
  const r = applyAutocut([clip], [{id: 'a', segments: [{inSec: 0, outSec: 2}, {inSec: 4, outSec: 10}]}]);
  const proj = projectGraphics([g], r.clips, 30);
  assert.equal(proj.length, 1); // the 2–4 s part is gone, the graphic is cut short at 2 s
  assert.equal(proj[0].startMs, 1000);
  assert.equal(proj[0].endMs, 2000);
});


test('matteSpans pads and merges behind-graphics per source, ignores front graphics', async () => {
  const {matteSpans} = await import('../src/graphicTemplates.ts');
  const g = (id, src, s, e, behind) => ({id, src, startMs: s, endMs: e, template: 'big-word', props: {}, behind});
  const spans = matteSpans([g('a', 'clips/x.mp4', 1000, 2000, true), g('b', 'clips/x.mp4', 2100, 3000, true), g('c', 'clips/x.mp4', 8000, 9000, true), g('d', 'clips/x.mp4', 4000, 5000, false), g('e', 'clips/y.mp4', 0, 500, true)], 300);
  assert.deepEqual(spans, [{src: 'clips/x.mp4', startMs: 700, endMs: 3300}, {src: 'clips/x.mp4', startMs: 7700, endMs: 9300}, {src: 'clips/y.mp4', startMs: 0, endMs: 800}]);
});
