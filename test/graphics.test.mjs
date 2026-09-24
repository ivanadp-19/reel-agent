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
