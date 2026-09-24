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
