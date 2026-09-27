import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {listFixtures} from '../scripts/reviews.mjs';
import {anchorAt} from '../scripts/review-states.mjs';

// The clients' regression fixtures (§7, T17): a note the agent resolved, kept in public/clients/<client>/fixtures/ (the
// volume, never git — scripts/reviews.mjs writeFixture), keyed by its anchor ids. Each one runs when its media is on
// this machine and is skipped with a warning when it is not: the note still anchors on the snapshot it was left on to
// the same clip, source second and word, and that word is still in the snapshot's captions.
function check(f) {
  assert.ok(f.snapshot, `${f.id}: its snapshot (${f.fixture.snapshot}) is missing or unreadable`);
  assert.deepEqual(anchorAt(f.snapshot, f.fixture.note.atSec), f.fixture.anchor, `${f.id}: the note no longer anchors where the client left it`);
  const wid = f.fixture.anchor.wordId;
  if (wid) assert.ok((f.snapshot.captions ?? []).some((c) => (c.words ?? []).some((w) => w.wid === wid)), `${f.id}: word ${wid} is gone from its snapshot`);
}

test('the clients\' fixtures on this machine (public/clients/*/fixtures/): each re-anchors to its ids; skipped with a warning without its media', async (t) => {
  const all = listFixtures(path.join(import.meta.dirname, '..', 'public'));
  if (!all.length) return t.skip('no client fixtures on this machine (public/clients/<client>/fixtures/)');
  for (const f of all) {
    await t.test(`${f.client}: ${f.id}`, (tt) => {
      if (f.missing.length) {
        console.warn(`fixture ${f.client}/${f.id} skipped: media missing on this machine — ${f.missing.join(', ')}`);
        return tt.skip(`media missing: ${f.missing.join(', ')}`);
      }
      check(f);
    });
  }
});

test('listFixtures: a fixture without its media is listed as missing (skipped), with it the check runs — and fails when the anchor moved', () => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-fixtures-'));
  try {
    const d = path.join(pub, 'clients', 'acme', 'fixtures');
    fs.mkdirSync(d, {recursive: true});
    const snapshot = {fps: 30, clips: [{id: 'c1', src: 'clips/b.mp4', inSec: 10, outSec: 20}], captions: [{src: 'clips/b.mp4', words: [{wid: 'b:2', text: 'propia', startMs: 10400, endMs: 10900}]}]};
    fs.writeFileSync(path.join(d, 'p-1-v1-n1.snapshot.json'), JSON.stringify(snapshot));
    const fixture = {id: 'p-1-v1-n1', client: 'acme', note: {id: 'n1', atSec: 0.5, text: 'x'}, anchor: {clipId: 'c1', src: 'clips/b.mp4', srcSec: 10.5, wordId: 'b:2'}, snapshot: 'p-1-v1-n1.snapshot.json', media: ['clips/b.mp4']};
    fs.writeFileSync(path.join(d, 'p-1-v1-n1.json'), JSON.stringify(fixture));
    let [f] = listFixtures(pub);
    assert.deepEqual([f.client, f.id, f.missing], ['acme', 'p-1-v1-n1', ['clips/b.mp4']]);
    fs.mkdirSync(path.join(pub, 'clips'));
    fs.writeFileSync(path.join(pub, 'clips', 'b.mp4'), 'mp4');
    [f] = listFixtures(pub);
    assert.deepEqual(f.missing, []);
    check(f);
    f.fixture.anchor = {...f.fixture.anchor, wordId: 'b:3'};
    assert.throws(() => check(f), /no longer anchors/);
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});
