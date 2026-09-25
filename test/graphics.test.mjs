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

test('a graphic follows its source through an autocut and keeps its duration across the cut', () => {
  const g = {id: 'g0', src: 'clips/a.mp4', startMs: 1000, endMs: 3000, template: 'stat', props: {value: '104 m²'}};
  const r = applyAutocut([clip], [{id: 'a', segments: [{inSec: 0, outSec: 2}, {inSec: 4, outSec: 10}]}]);
  const proj = projectGraphics([g], r.clips, 30);
  assert.equal(proj.length, 1); // anchored once, on the segment that holds its start
  assert.equal(proj[0].startMs, 1000);
  assert.equal(proj[0].endMs, 3000); // 2 s on screen, running over the cut at 2 s
});


test('matteSpans pads and merges behind-graphics per source, ignores front graphics', async () => {
  const {matteSpans} = await import('../src/graphicTemplates.ts');
  const g = (id, src, s, e, behind) => ({id, src, startMs: s, endMs: e, template: 'big-word', props: {}, behind});
  const spans = matteSpans([g('a', 'clips/x.mp4', 1000, 2000, true), g('b', 'clips/x.mp4', 2100, 3000, true), g('c', 'clips/x.mp4', 8000, 9000, true), g('d', 'clips/x.mp4', 4000, 5000, false), g('e', 'clips/y.mp4', 0, 500, true)], {padMs: 300});
  assert.deepEqual(spans, [{src: 'clips/x.mp4', startMs: 700, endMs: 3300}, {src: 'clips/x.mp4', startMs: 7700, endMs: 9300}, {src: 'clips/y.mp4', startMs: 0, endMs: 800}]);
});

import {parseProps as parse2, describeSchema, TEMPLATES as T2} from '../src/graphicTemplates.ts';

test('hook-stack lines accept bare strings', () => {
  const p = parse2('hook-stack', {lines: ['THE BIGGEST LIE', {text: 'ABOUT MONEY', accent: true}]});
  assert.deepEqual(p.lines.map((l) => [l.text, l.size, l.accent]), [['THE BIGGEST LIE', 'lg', false], ['ABOUT MONEY', 'lg', true]]);
});

test('the props help spells out enum options and length limits', () => {
  const h = describeSchema(T2['big-word'].schema);
  assert.match(h, /size: lg\|xl\|xxl/);
  assert.match(h, /text: string ≤16 chars/);
  assert.match(describeSchema(T2['hook-stack'].schema), /lines: \[\{text: string ≤22 chars/);
});

import {projectGraphics as project2} from '../src/graphicTemplates.ts';
import {validateProject as validate2} from '../src/validate.ts';

test('a graphic keeps its full duration across a cut, behind or not; its matte covers every piece under it', async () => {
  const a = {id: 'a', src: 'clips/a.mp4', inSec: 0, outSec: 2, sourceDurationSec: 10};
  const b = {id: 'b', src: 'clips/a.mp4', inSec: 5, outSec: 10, sourceDurationSec: 10};
  const label = {id: 'g0', src: 'clips/a.mp4', startMs: 1500, endMs: 3700, template: 'label-2tone', props: {top: 'x'}};
  const [p] = project2([label], [a, b], 30);
  assert.equal(p.startMs, 1500); assert.equal(p.endMs, 3700); assert.equal(p.clipId, 'a');
  const [q] = project2([{...label, behind: true}], [a, b], 30);
  assert.equal(q.endMs, 3700); // runs across the cut like any graphic (run 4: "truncated to 0.5 s")
  const {matteSpans} = await import('../src/graphicTemplates.ts');
  // 1.5–2 s on clip a (source 1.5–2), then 2–3.7 s on clip b (source 5–6.7), each padded 300 ms
  assert.deepEqual(matteSpans([{...label, behind: true}], {clips: [a, b]}), [{src: 'clips/a.mp4', startMs: 1200, endMs: 2300}, {src: 'clips/a.mp4', startMs: 4700, endMs: 7000}]);
  assert.equal(project2([{...label, startMs: 1500, endMs: 6000}], [a, b], 30).length, 1); // anchored once, not again on clip b
});

test('validate warns when a text graphic sits on the presenter face', () => {
  const clip = {id: 'a', src: 'clips/a.mp4', inSec: 0, outSec: 10, sourceDurationSec: 10};
  const hook = {id: 'g0', src: 'clips/a.mp4', startMs: 100, endMs: 2900, template: 'hook-stack', props: {lines: [{text: 'A', size: 'lg', accent: false}], upper: false}};
  const faces = {'clips/a.mp4': {found: true, top: 0.14, bottom: 0.38}};
  const codes = (g, y) => validate2({clips: [clip], captions: [], graphics: [{...g, ...(y != null ? {yPct: y} : {})}]}, 30, faces).map((i) => i.code);
  assert.ok(codes(hook).includes('face'));
  assert.ok(!codes(hook, 45).includes('face'));
  assert.ok(!codes({...hook, behind: true}).includes('face'));
});

import {spansWithoutMatte} from '../src/graphicTemplates.ts';

test('behind caption pages need a matte too; a covering matte satisfies them', () => {
  const page = {id: 'c0', src: 'clips/a.mp4', startMs: 1000, endMs: 2000, behind: true, words: []};
  assert.deepEqual(spansWithoutMatte([page], []), [{src: 'clips/a.mp4', startMs: 700, endMs: 2300}]);
  assert.deepEqual(spansWithoutMatte([page], [{src: 'clips/a.mp4', startMs: 0, endMs: 5000}]), []);
  assert.deepEqual(spansWithoutMatte([{...page, behind: false}], []), []);
});

import {oversizedPx, parseProps as parse3} from '../src/graphicTemplates.ts';
import {ink} from '../src/brand.ts';
import {validateProject as validate3} from '../src/validate.ts';

test('new templates validate their props and fill defaults', () => {
  assert.equal(parse3('oversized', {text: 'wealth'}).color, 'accent');
  assert.equal(parse3('chapter-caps', {text: 'chapter one'}).rules, true);
  assert.equal(parse3('starburst', {text: 'NEW!'}).size, 'md');
  assert.equal(parse3('location-tag', {place: 'Mérida, Yucatán'}).sub, '');
  assert.equal(parse3('price', {value: '$2.5M', label: 'DESDE'}).countUp, true);
  assert.throws(() => parse3('starburst', {text: 'WAY TOO LONG SHOUT'}), /text/);
});

test('oversized words are sized past the frame so both edges crop them', async () => {
  const {textWidthEm} = await import('../src/textFit.ts');
  const w = oversizedPx('WEALTH', 'condensed') * textWidthEm('WEALTH', 'Anton');
  assert.ok(w > 1300 && w < 1500, String(w)); // ~1.3 × 1080 wide
});

test('ink picks dark text on light fills and white on dark ones', () => {
  assert.equal(ink('#FFB020'), '#111111');
  assert.equal(ink('#0b0b0d'), '#ffffff');
  assert.equal(ink('#3B5BFF'), '#ffffff');
});

test('a starburst may share the screen with a label; two labels may not', () => {
  const clip = {id: 'a', src: 'clips/a.mp4', inSec: 0, outSec: 10, sourceDurationSec: 10};
  const g = (id, template, props) => ({id, src: 'clips/a.mp4', startMs: 1000, endMs: 3000, template, props});
  const codes = (items) => validate3({clips: [clip], captions: [], graphics: items}).map((i) => i.code);
  assert.ok(!codes([g('g0', 'label-2tone', {top: 'A', bottom: ''}), g('g1', 'starburst', {text: 'NEW!', size: 'md', xPct: 72})]).includes('overlap-graphics'));
  assert.ok(codes([g('g0', 'label-2tone', {top: 'A', bottom: ''}), g('g1', 'price', {value: '$1', label: '', note: ''})]).includes('overlap-graphics'));
});

test('end-card: defaults, full frame; captions under it are hidden, a page running into it is cut', async () => {
  const {parseProps: pp, FULL_FRAME} = await import('../src/graphicTemplates.ts');
  const {hideUnder} = await import('../src/captions.ts');
  assert.deepEqual(pp('end-card', {title: 'Save this for later'}), {title: 'Save this for later', cta: 'Follow for more', handle: '', bg: 'dark'});
  assert.ok(FULL_FRAME.has('end-card'));
  const page = (id, a, b) => ({id, src: 's', words: [], startMs: a, endMs: b, topPct: 58, holdMaxMs: 99999});
  const r = hideUnder([page('c0', 1000, 2000), page('c1', 7000, 8500), page('c2', 8600, 9000)], [{startMs: 8000, endMs: 10000}]);
  assert.deepEqual(r.map((c) => [c.id, c.endMs, c.holdMaxMs]), [['c0', 2000, 8000], ['c1', 8000, 8000]]); // no page may hold into the card
});

test('location-tag accepts text as an alias of place', async () => {
  const {parseProps: pp} = await import('../src/graphicTemplates.ts');
  assert.equal(pp('location-tag', {text: 'Norte de Mérida'}).place, 'Norte de Mérida');
  assert.equal(pp('location-tag', {label: 'Mérida', sub: 'Yucatán'}).place, 'Mérida');
  assert.equal(pp('location-tag', {place: 'Mérida', text: 'ignored'}).place, 'Mérida');
});

import {parseProps as parse4, REVEAL_KINDS, OUT_KINDS, LIFE_KINDS, CENTERED as C4, DECOR_FULL, describeSchema as ds4, TEMPLATES as T4} from '../src/graphicTemplates.ts';

test('phase 3 templates parse with defaults and describe themselves', () => {
  assert.deepEqual(parse4('band-title', {text: 'FOLLOWERS'}), {text: 'FOLLOWERS', font: 'display'});
  assert.equal(parse4('neon-frame', {}).tilt, 10);
  assert.equal(parse4('scribble', {shape: 'underline'}).color, 'light');
  assert.equal(parse4('outline-rect', {}).inset, 12);
  assert.equal(parse4('frame-light', {laps: 3}).laps, 3);
  assert.equal(parse4('starburst', {text: 'NEW'}).anim, 'pop');
  assert.throws(() => parse4('scribble', {shape: 'zigzag'}));
  for (const id of ['band-title', 'neon-frame', 'scribble', 'outline-rect', 'frame-light']) assert.ok(ds4(T4[id].schema).startsWith('{'));
  assert.ok(C4.has('neon-frame') && C4.has('scribble') && DECOR_FULL.has('frame-light'));
  assert.ok(REVEAL_KINDS.includes('letters') && OUT_KINDS.includes('band') && LIFE_KINDS.includes('marquee'));
});

import {parseProps as parse5, matteSpans as ms5, CENTERED as C5, DECOR_FULL as D5, MATTE_TEMPLATES} from '../src/graphicTemplates.ts';

test('phase 4 templates: layout enter / cutout / window / grid, ornament, rules, person-outline, sticker unfold', () => {
  const lay = parse5('layout', {shape: 'window', canvas: 'grid', enter: 'slide'});
  assert.equal(lay.enter, 'slide'); assert.equal(lay.cutout, false);
  assert.equal(parse5('layout', {}).enter, 'frameIn');
  assert.throws(() => parse5('layout', {enter: 'bounce'}));
  assert.equal(parse5('ornament', {}).glyph, '✳');
  assert.equal(parse5('rules', {orientation: 'vertical'}).widthPx, 2);
  assert.equal(parse5('person-outline', {}).boil, true);
  const st = parse5('sticker', {src: 'assets/x.png', anim: 'unfold', xPct: 20});
  assert.equal(st.fromXPct, 50); assert.equal(st.fromYPct, 38);
  assert.ok(C5.has('ornament') && D5.has('rules') && D5.has('person-outline') && MATTE_TEMPLATES.has('person-outline'));
});

test('a person-outline graphic and a cutout layout need a matte for their span, like behind graphics', () => {
  const g = (template, props, behind = false) => ({id: 'g', src: 's', startMs: 1000, endMs: 3000, template, props, behind});
  assert.deepEqual(ms5([g('person-outline', {color: 'accent', widthPx: 6, boil: true})]).map((x) => [x.startMs, x.endMs]), [[700, 3300]]);
  assert.deepEqual(ms5([g('layout', {cutout: true})]).map((x) => [x.startMs, x.endMs]), [[700, 3300]]);
  assert.deepEqual(ms5([g('layout', {cutout: false})]), []);
  assert.deepEqual(ms5([g('stat', {value: '1'})]), []);
});

test('fieldsOf turns a template schema into form fields (kind, options, defaults, nested rows)', async () => {
  const {fieldsOf, TEMPLATES} = await import('../src/graphicTemplates.ts');
  const stat = fieldsOf(TEMPLATES.stat.schema);
  assert.deepEqual(stat.map((f) => [f.key, f.kind, f.required]), [['value', 'string', true], ['label', 'string', false], ['countUp', 'boolean', false]]);
  assert.equal(stat[0].max, 14);
  assert.equal(stat[2].default, true);
  const hook = fieldsOf(TEMPLATES['hook-stack'].schema);
  const lines = hook.find((f) => f.key === 'lines');
  assert.equal(lines.kind, 'array');
  assert.deepEqual([lines.min, lines.max], [1, 4]);
  assert.deepEqual(lines.item.map((f) => [f.key, f.kind]), [['text', 'string'], ['size', 'enum'], ['accent', 'boolean']]);
  assert.deepEqual(lines.item[1].options, ['sm', 'md', 'lg', 'xl']);
  assert.equal(lines.item[1].default, 'lg');
  const neon = fieldsOf(TEMPLATES['neon-frame'].schema).find((f) => f.key === 'xPct');
  assert.deepEqual([neon.kind, neon.min, neon.max, neon.default, neon.desc], ['number', 0, 100, 50, 'center x, % of frame width']);
  // every template (including the preprocess-wrapped ones) yields known field kinds
  for (const [id, t] of Object.entries(TEMPLATES)) {
    const fs = fieldsOf(t.schema);
    assert.ok(fs.length, id);
    for (const f of fs) assert.ok(['string', 'number', 'boolean', 'enum', 'array'].includes(f.kind), `${id}.${f.key} is ${f.kind}`);
  }
});
