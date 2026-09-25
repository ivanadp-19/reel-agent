import {test} from 'node:test';
import assert from 'node:assert/strict';
import {brandSchema, resolveBrand} from '../src/brand.ts';
import {fitSize} from '../src/textFit.ts';

test('no kit: project accent, stock canvases, not branded', () => {
  const k = resolveBrand(null, '#123456');
  assert.deepEqual([k.branded, k.accent, k.dark, k.light, k.display], [false, '#123456', '#0b0b0d', '#f3f3f0', undefined]);
});

test('a kit wins over the project accent and brings its fonts', () => {
  const b = brandSchema.parse({name: 'Acme', colors: {accent: '#E63312', dark: '#101820'}, fonts: {display: 'Anton', body: 'Poppins'}});
  const k = resolveBrand(b, '#FFB020');
  assert.deepEqual([k.branded, k.accent, k.dark, k.light, k.display, k.body], [true, '#E63312', '#101820', '#f3f3f0', 'Anton', 'Poppins']);
});

test('the kit schema rejects fonts outside the OFL catalog and bad colors', () => {
  assert.equal(brandSchema.safeParse({colors: {accent: '#E63312'}, fonts: {display: 'Comic Sans'}}).success, false);
  assert.equal(brandSchema.safeParse({colors: {accent: 'red'}}).success, false);
});

test('fitSize: short text keeps its size; long or wide-font text shrinks to the width', () => {
  assert.equal(fitSize('LIE', 180), 180);
  const wealth = fitSize('WEALTH', 270, 'Playfair Display', 1000); // size xxl
  assert.ok(wealth < 270 && wealth > 200, String(wealth)); // the run-2 "WEALTH" that ran off the frame
  assert.ok(fitSize('BIGGEST LIE', 180, 'Unbounded') < fitSize('BIGGEST LIE', 180, 'Anton'));
  assert.equal(fitSize('a very long label that will not fit', 72, 'Montserrat', 940, 52), 52); // floor
});

import {legible, luminance} from '../src/brand.ts';

test('legible lightens a dark brand accent for text and leaves bright ones alone', () => {
  assert.equal(legible('#FFB020'), '#FFB020');
  assert.equal(legible('#9FD9DC'), '#9FD9DC');
  const blue = legible('#2F6BFF'); // run 4's brand blue, unreadable over a navy blouse
  assert.notEqual(blue, '#2F6BFF');
  assert.ok(luminance(blue) >= 0.3 && luminance(blue) < 0.45, `${blue} ${luminance(blue)}`);
  assert.ok(parseInt(blue.slice(5, 7), 16) === 255, 'still blue');
});

test('client fonts: family and weight come from the file name unless given', async () => {
  const {clientFont, heaviest} = await import('../src/fonts.ts');
  assert.deepEqual(clientFont('fonts/Helvetica-Bold.ttf'), {family: 'Helvetica', file: 'fonts/Helvetica-Bold.ttf', weight: 700});
  assert.deepEqual(clientFont('fonts/HelveticaNeue-BoldItalic.otf'), {family: 'Helvetica Neue', file: 'fonts/HelveticaNeue-BoldItalic.otf', weight: 700, italic: true});
  assert.equal(clientFont('fonts/Brand_Black.woff2').weight, 900);
  assert.equal(clientFont('fonts/x.ttf', 'Acme Sans', 500).family, 'Acme Sans');
  assert.equal(heaviest('Helvetica', [clientFont('fonts/Helvetica-Bold.ttf'), clientFont('fonts/Helvetica-Regular.ttf')]), 700);
  assert.equal(heaviest('Inter'), 800);
});

test("César's caption spec validates: Helvetica Bold (client file) white with a #FFE500 accent", async () => {
  const {brandSchema, resolveBrand} = await import('../src/brand.ts');
  const kit = {name: 'VIBEM', colors: {accent: '#FFE500'}, fonts: {body: 'Helvetica', files: [{family: 'Helvetica', file: 'fonts/Helvetica-Bold.ttf', weight: 700}]}};
  const r = brandSchema.safeParse(kit);
  assert.ok(r.success, JSON.stringify(r.error?.issues));
  const k = resolveBrand(r.data);
  assert.equal(k.body, 'Helvetica'); assert.equal(k.accent, '#FFE500'); assert.equal(k.fontFiles.length, 1);
  // a family that is neither in the catalog nor in the kit's files is refused
  assert.ok(!brandSchema.safeParse({...kit, fonts: {body: 'Helvetica'}}).success);
  // font files must stay under public/
  assert.ok(!brandSchema.safeParse({...kit, fonts: {files: [{family: 'X', file: '/etc/x.ttf', weight: 400}]}}).success);
  assert.ok(!brandSchema.safeParse({...kit, fonts: {files: [{family: 'X', file: '../x.ttf', weight: 400}]}}).success);
});

test('a client font family is recognized however it is typed', async () => {
  const {clientFont, resolveFamily} = await import('../src/fonts.ts');
  const files = [clientFont('fonts/DejaVuSans-Bold.ttf')];
  assert.equal(files[0].family, 'Deja Vu Sans'); // what the file name gives
  for (const typed of ['DejaVu Sans', 'dejavu-sans', 'Deja Vu Sans']) assert.equal(resolveFamily(typed, files), 'Deja Vu Sans');
  assert.equal(resolveFamily('bebas neue'), 'Bebas Neue');
  assert.equal(resolveFamily('Unknown Face', files), 'Unknown Face');
});

test('style kits: a flexible spec from the client\'s words — known keys typed, any other preference kept', async () => {
  const {brandSchema, mergeStyle, styleEffects, styleSchema} = await import('../src/brand.ts');
  const words = {notes: 'Sin subtítulos por defecto. Color natural, nada quemado, piel sin naranja.', captions: 'off', grade: {look: 'natural', skin: 0.8, highlights: 0.7}, pace: 'rápido, cortes secos', zooms: 'nunca', maxReelSec: 45};
  const st = styleSchema.parse(words);
  assert.equal(st.zooms, 'nunca'); assert.equal(st.maxReelSec, 45); // not in the schema, kept
  assert.ok(!styleSchema.safeParse({captions: 'sometimes'}).success);
  assert.ok(!styleSchema.safeParse({grade: {look: 'teal-orange'}}).success, 'looks are the real ones');
  assert.ok(!styleSchema.safeParse({weird: {nested: true}}).success, 'extra preferences are plain values');
  // adjusted by prompt: key by key, null removes
  const next = mergeStyle(st, {captions: 'on', grade: {adjust: {temperature: -0.2}}, zooms: null});
  assert.equal(next.captions, 'on'); assert.equal(next.zooms, undefined);
  assert.deepEqual(next.grade, {look: 'natural', skin: 0.8, highlights: 0.7, adjust: {temperature: -0.2}});
  // what loading it does to a project
  assert.deepEqual(styleEffects(st), {captionsOff: true, grade: {look: 'natural', skin: 0.8, highlights: 0.7}});
  assert.ok(brandSchema.safeParse({colors: {accent: '#FFE500'}, style: st}).success);
});
