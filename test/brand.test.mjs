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
