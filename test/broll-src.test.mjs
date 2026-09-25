import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {brollKind, brollSrc} from '../mcp/broll.mjs';

// the G4 render failure: edit_broll stored an absolute path the render could not read
test('an absolute B-roll file is copied into public/broll/ (add_broll and edit_broll share this)', () => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-'));
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'src-')), 'mi toma.mp4');
  fs.writeFileSync(outside, 'x');
  const s = brollSrc(outside, pub);
  assert.equal(s, 'broll/mi_toma.mp4');
  assert.ok(fs.existsSync(path.join(pub, s)));
  assert.equal(brollSrc(s, pub), s); // a path inside public/ stays
  assert.equal(brollSrc('https://videos.pexels.com/x.mp4', pub), 'https://videos.pexels.com/x.mp4');
  assert.throws(() => brollSrc('/nope/none.mp4', pub), /file not found/);
  assert.throws(() => brollSrc('broll/none.mp4', pub), /not found in public/);
});

test('kind follows the file', () => {
  assert.equal(brollKind('broll/a.JPG'), 'image');
  assert.equal(brollKind('https://images.pexels.com/p.jpeg?auto=compress'), 'image');
  assert.equal(brollKind('broll/a.mp4'), 'video');
});
