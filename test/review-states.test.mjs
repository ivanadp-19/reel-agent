// The life cycle of review versions and notes (scripts/review-states.mjs, CEO-12 / D22): every transition, the
// invalid ones refused, the QC helper, the note anchor on a snapshot and the owner's inbox.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NOTE_STEPS, actorOf, addNote, anchorAt, approve, moveNote, noteClock, openNotes, ownerInbox, reviewState, revoke, variantName, variantState, versionLabel, versionQc} from '../scripts/review-states.mjs';
import {DELIVERY_FPS} from '../src/timeline.ts';
import {pageWords} from '../src/paging.ts';
import {presetOf} from '../src/captionPresets.ts';

const IDENTITY = {client: 'acme', family: 'acme-G2', script: 2, variant: {hook: 1, cta: 1}};
const AT = '2026-09-27T10:00:00.000Z';
const version = (v, label = 'superado', extra = {}) => ({v, durationSec: 30, identity: IDENTITY, judge: {label, findings: [], at: AT}, ...extra});
// the gate's answers (server/http.mjs gate) as the steps see them
const rev = actorOf({via: 'session', user: 'cesar', role: 'reviewer', clients: ['acme']});
const owner = actorOf({via: 'session', user: 'felipe', role: 'owner', clients: []});
const other = actorOf({via: 'session', user: 'otro', role: 'reviewer', clients: ['other']});
const agent = actorOf({via: 'backend-token', primary: true});
const refused = (fn, status, code) => assert.throws(fn, (e) => e.status === status && (!code || e.code === code), `expected ${status} ${code ?? ''}`);

test('actors: only a login session with a role is a human — tokens, basic auth and loopback are agents', () => {
  assert.deepEqual([rev.kind, owner.kind, other.kind, agent.kind], ['reviewer', 'owner', 'reviewer', 'agent']);
  assert.equal(actorOf({via: 'session', user: 'nadie', role: null}).kind, 'nobody');
  for (const via of ['basic', 'loopback', 'user-token', 'backend-token']) assert.equal(actorOf({via, user: 'felipe', role: 'owner'}).kind, 'agent', via);
  assert.equal(actorOf(null).kind, 'agent');
});

test('versionQc, the one reader of a version\'s QC: only superado (reduced evidence included) approves', () => {
  const rows = [['en curso', 'en curso', 'QC técnico en curso'], ['superado', 'superado', 'QC técnico superado'], ['superado (evidencia reducida)', 'superado', 'QC técnico superado (evidencia reducida)'],
    ['1 hallazgo', 'hallazgos', 'QC técnico: 1 hallazgo'], ['3 hallazgos', 'hallazgos', 'QC técnico: 3 hallazgos'], ['no disponible', 'no disponible', 'QC técnico no disponible']];
  for (const [label, state, text] of rows) assert.deepEqual([versionQc(version(1, label)).state, versionQc(version(1, label)).label, versionQc(version(1, label)).approvable], [state, text, state === 'superado'], label);
  assert.deepEqual([versionQc({v: 1}).state, versionQc({v: 1}).approvable], ['sin QC', false], 'a version never judged');
});

test('approve: only from QC superado, only the client\'s reviewer, only retyping the variant name; twice = no change', () => {
  assert.equal(variantName(IDENTITY), 'ACME_G2_H1_C1');
  for (const label of ['en curso', '2 hallazgos', 'no disponible']) refused(() => approve(version(1, label), rev, {name: 'ACME_G2_H1_C1', at: AT}), 409, 'qc_not_passed');
  refused(() => approve({v: 1, identity: IDENTITY}, rev, {name: 'ACME_G2_H1_C1', at: AT}), 409, 'qc_not_passed');
  refused(() => approve(version(1), owner, {name: 'ACME_G2_H1_C1', at: AT}), 403, 'forbidden'); // the owner never writes approval
  refused(() => approve(version(1), agent, {name: 'ACME_G2_H1_C1', at: AT}), 403, 'forbidden'); // nor any token
  refused(() => approve(version(1), other, {name: 'ACME_G2_H1_C1', at: AT}), 403, 'forbidden'); // nor another client's reviewer
  refused(() => approve(version(1), rev, {name: 'ACME_G2_H1_C2', at: AT}), 400, 'confirm_mismatch');
  refused(() => approve(version(1), rev, {at: AT}), 400, 'confirm_mismatch');
  const x = version(1, 'superado (evidencia reducida)');
  assert.equal(approve(x, rev, {name: ' acme_g2_h1_c1 ', at: AT, ipHash: 'abc', userAgent: 'Phone'}), true, 'a phone\'s lower case and spaces are fine');
  assert.deepEqual(x.approval, {by: 'cesar', at: AT, ipHash: 'abc', userAgent: 'Phone'});
  assert.equal(reviewState(x), 'aprobada');
  assert.equal(approve(x, rev, {name: 'ACME_G2_H1_C1', at: 'later'}), false, 'a double click');
  x.judge.label = '1 hallazgo';
  assert.equal(approve(x, rev, {name: 'ACME_G2_H1_C1', at: 'later'}), false, 'an approved version is not re-judged into refusing its own approval');
  assert.deepEqual(x.log, [{action: 'aprobar', by: 'cesar', at: AT, openNotes: 0}]);
});

test('revoke: the reviewer, with a reason, only an approved version → por revisar (cambios with an open note)', () => {
  const x = version(1);
  refused(() => revoke(x, rev, {reason: 'x', at: AT}), 409, 'not_approved');
  approve(x, rev, {name: 'ACME_G2_H1_C1', at: AT});
  refused(() => revoke(x, rev, {reason: '  ', at: AT}), 400, 'reason_required');
  refused(() => revoke(x, owner, {reason: 'no', at: AT}), 403);
  refused(() => revoke(x, agent, {reason: 'no', at: AT}), 403);
  refused(() => revoke(x, rev, {reason: 'x'.repeat(501), at: AT}), 400, 'too_long');
  assert.equal(revoke(x, rev, {reason: 'el logo sale cortado', at: 'later'}), true);
  assert.equal(x.approval, undefined);
  assert.equal(reviewState(x), 'por revisar');
  assert.deepEqual(x.log.at(-1), {action: 'revocar', by: 'cesar', at: 'later', reason: 'el logo sale cortado', approval: {by: 'cesar', at: AT}});
  addNote(x, rev, {atSec: 3, text: 'otra cosa', at: AT});
  assert.equal(reviewState(x), 'cambios');
});

test('variant: sin versiones → por revisar → cambios → aprobada = vK; a newer approval supersedes the older; revoking it hands back the older', () => {
  assert.deepEqual(variantState([]), {state: 'sin versiones', delivered: null});
  const [v1, v2, v3] = [version(1), version(2), version(3)];
  assert.deepEqual(variantState([v1]), {state: 'por revisar', delivered: null});
  addNote(v1, rev, {atSec: 1, text: 'sube la música', at: AT});
  assert.deepEqual(variantState([v1, v2]), {state: 'cambios', delivered: null});
  approve(v2, rev, {name: 'ACME_G2_H1_C1', at: AT});
  assert.deepEqual(variantState([v1, v2]), {state: 'aprobada', delivered: 2});
  approve(v3, rev, {name: 'ACME_G2_H1_C1', at: AT});
  const vs = [v1, v2, v3], {delivered} = variantState(vs);
  assert.equal(delivered, 3);
  assert.deepEqual(vs.map((x) => versionLabel(x, delivered)), ['cambios', 'aprobada, reemplazada', 'aprobada']);
  revoke(v3, rev, {reason: 'me equivoqué de versión', at: AT});
  assert.deepEqual(variantState(vs), {state: 'aprobada', delivered: 2});
});

test('notes: the reviewer leaves them (plain text, bounded, a second inside the reel); on an approved version it stays approved, flagged', () => {
  const x = version(1);
  refused(() => addNote(x, owner, {atSec: 1, text: 'x', at: AT}), 403);
  refused(() => addNote(x, agent, {atSec: 1, text: 'x', at: AT}), 403);
  refused(() => addNote(x, other, {atSec: 1, text: 'x', at: AT}), 403);
  refused(() => addNote(x, rev, {atSec: 1, text: '  \n ', at: AT}), 400, 'text_required');
  refused(() => addNote(x, rev, {atSec: 1, text: 'x'.repeat(2001), at: AT}), 400, 'too_long');
  for (const atSec of [NaN, -1, 31]) refused(() => addNote(x, rev, {atSec, text: 'x', at: AT}), 400, 'bad_time');
  const n1 = addNote(x, rev, {atSec: 20.4, text: 'la música\r\ntapa la voz\u0007', anchor: {clipId: 'c1'}, at: AT});
  assert.deepEqual(n1, {id: 'n1', v: 1, atSec: 20.4, text: 'la música\ntapa la voz', anchor: {clipId: 'c1'}, by: 'cesar', at: AT, state: 'abierta', history: [{state: 'abierta', by: 'cesar', at: AT}]});
  approve(x, rev, {name: 'ACME_G2_H1_C1', at: AT});
  const n2 = addNote(x, rev, {atSec: 3, text: 'y el logo', at: AT});
  assert.deepEqual([n2.id, n2.afterApproval, reviewState(x)], ['n2', true, 'aprobada'], 'nota después de aprobar');
  assert.equal(openNotes(x).length, 2);
  assert.equal(noteClock(20.4), '0:20.4');
  assert.equal(noteClock(59.96), '1:00.0');
});

test('every note transition: abierta → clasificada → confirmada → resuelta → verificada | descartada, each by its principal; the rest refused', () => {
  const STATES = ['abierta', 'clasificada', 'confirmada', 'resuelta', 'verificada', 'descartada'];
  const WHO = {agent, owner, reviewer: rev};
  const args = {clasificar: {kind: 'fix'}, confirmar: {}, resolver: {v: 2}, verificar: {}, descartar: {reason: 'no aplica'}};
  const noteIn = (state) => { const x = version(1); const n = addNote(x, rev, {atSec: 1, text: 'n', at: AT}); n.state = state; return x; };
  for (const state of STATES) {
    for (const [step, s] of Object.entries(NOTE_STEPS)) {
      const x = noteIn(state);
      const ok = s.from.includes(state) || s.to === state;
      if (!ok) { refused(() => moveNote(x, 'n1', step, WHO[s.who], {at: AT, ...args[step]}), 409, 'invalid_transition'); continue; }
      const n = moveNote(x, 'n1', step, WHO[s.who], {at: AT, ...args[step]});
      assert.equal(n.state, s.to, `${state} —${step}→`);
      // the wrong principal never moves it, whatever the state
      for (const [who, actor] of Object.entries({agent, owner, reviewer: rev, other})) if (who !== s.who && s.to !== state) refused(() => moveNote(noteIn(state), 'n1', step, actor, {at: AT, ...args[step]}), 403);
    }
  }
  // the whole road, as it happens: César notes v1, the agent classifies, Felipe confirms, v2 fixes it, César verifies on v2
  const x = version(1);
  addNote(x, rev, {atSec: 20.4, text: 'la música tapa la voz', at: AT});
  refused(() => moveNote(x, 'n1', 'verificar', rev, {at: AT}), 409, 'invalid_transition'); // verificada without resuelta
  refused(() => moveNote(x, 'n1', 'clasificar', agent, {at: AT, kind: 'capricho'}), 400, 'bad_kind');
  moveNote(x, 'n1', 'clasificar', agent, {at: AT, kind: 'fix'});
  refused(() => moveNote(x, 'n1', 'resolver', agent, {at: AT, v: 2}), 409); // not confirmed yet
  moveNote(x, 'n1', 'confirmar', owner, {at: AT});
  assert.equal(moveNote(x, 'n1', 'confirmar', owner, {at: 'again'}).history.length, 3, 'a double click is no change');
  refused(() => moveNote(x, 'n1', 'resolver', agent, {at: AT, v: 1}), 400, 'bad_version'); // fixed in a LATER version
  moveNote(x, 'n1', 'resolver', agent, {at: AT, v: 2});
  const n = moveNote(x, 'n1', 'verificar', rev, {at: AT});
  assert.deepEqual([n.state, n.kind, n.resolvedIn, n.history.map((h) => `${h.state}:${h.by}`)], ['verificada', 'fix', 2, ['abierta:cesar', 'clasificada:backend-token', 'confirmada:felipe', 'resuelta:backend-token', 'verificada:cesar']]);
  assert.equal(openNotes(x).length, 0);
  assert.deepEqual(x.log.map((l) => l.action), ['nota', 'clasificar', 'confirmar', 'resolver', 'verificar']);
  // descartada: the owner, with the reason the reviewer sees
  const y = version(1);
  addNote(y, rev, {atSec: 2, text: 'n', at: AT});
  refused(() => moveNote(y, 'n1', 'descartar', owner, {at: AT}), 400, 'reason_required');
  assert.equal(moveNote(y, 'n1', 'descartar', owner, {at: AT, reason: 'es el guion'}).reason, 'es el guion');
  refused(() => moveNote(y, 'n9', 'descartar', owner, {at: AT, reason: 'x'}), 404);
  refused(() => moveNote(y, 'n1', 'borrar', owner, {at: AT}), 400, 'bad_step');
  refused(() => moveNote(y, 'n1', '__proto__', owner, {at: AT}), 400, 'bad_step');
});

// two sources: c0 = a.mp4 0–4 s, c1 = b.mp4 from 10 s (the take's second half); captions in source ms
const SNAPSHOT = {
  fps: DELIVERY_FPS,
  clips: [{id: 'c0', src: 'clips/a.mp4', inSec: 0, outSec: 4}, {id: 'c1', src: 'clips/b.mp4', inSec: 10, outSec: 20}],
  captions: [
    {id: 'p0', src: 'clips/a.mp4', startMs: 0, endMs: 1000, words: [{wid: 'a:0', text: 'Hola', startMs: 0, endMs: 1000}]},
    {id: 'p1', src: 'clips/b.mp4', startMs: 9000, endMs: 12500, words: [{wid: 'b:0', text: 'antes', startMs: 9000, endMs: 9900}, {wid: 'b:1', text: 'tu', startMs: 10000, endMs: 10400}, {wid: 'b:2', text: 'propia', startMs: 10400, endMs: 10900}, {wid: 'b:3', text: 'cava', startMs: 12000, endMs: 12500}]},
  ],
};
test('a note anchors to the clip, source second and word of the version as rendered (its snapshot, at its own fps)', () => {
  // c0 is 120 frames at 29.97 = 4.004 s: 4.5 s on the reel is b.mp4 at 10.496 s — inside "propia"
  assert.deepEqual(anchorAt(SNAPSHOT, 4.5), {clipId: 'c1', src: 'clips/b.mp4', srcSec: 10.496, wordId: 'b:2'});
  assert.equal(anchorAt(SNAPSHOT, 0.5).wordId, 'a:0');
  assert.equal(anchorAt(SNAPSHOT, 4.004 + 1.5).wordId, 'b:3', 'between words: the nearest (0.5 s to "cava", 0.6 s back to "propia")');
  assert.equal(anchorAt(SNAPSHOT, 2.5).wordId, null, 'nothing said within 1 s');
  assert.equal(anchorAt(SNAPSHOT, 4.1).wordId, 'b:1', '"antes" (9.0–9.9 s) was trimmed away: never the word of a cut');
  assert.equal(anchorAt({...SNAPSHOT, fps: 30}, 4.5).srcSec, 10.5, 'at 30 fps the same second is another source time');
  assert.equal(anchorAt({clips: []}, 1), null);
  assert.equal(anchorAt(null, 1), null);
});

test('the owner\'s inbox: notes to confirm, guion-conflict, a judge down, 3 reds in a row, low disk, notes on v1 per variant by G', () => {
  const W = (rows) => rows.map(([word, s, e], i) => ({wid: `v:${i}`, word, src: 'clips/v.mp4', clipId: 'k1', startMs: s, endMs: e, srcStartMs: s, srcEndMs: e}));
  const words = W([['Caben', 0, 300], ['70', 320, 700], ['invitados', 720, 1200], ['en', 1220, 1300], ['el', 1320, 1400], ['salón.', 1420, 1900]]);
  const project = {identity: IDENTITY, clips: [{id: 'k1', src: 'clips/v.mp4', inSec: 0, outSec: 60, sourceDurationSec: 60}], captions: pageWords(words, presetOf('palabra')), graphics: [], captionStyle: 'palabra', guion: 'Caben 60 invitados en el salón.'};
  const v1 = version(1, '2 hallazgos'), v2 = version(2, '1 hallazgo'), v3 = version(3, '4 hallazgos');
  addNote(v1, rev, {atSec: 20.4, text: 'la\nmúsica   tapa la voz', at: AT});
  addNote(v1, rev, {atSec: 5, text: 'ya visto', at: AT}).state = 'confirmada'; // confirmed: not waiting for the owner
  const g3 = {...IDENTITY, family: 'acme-G3', script: 3, variant: {hook: 1}};
  const rows = [
    {projectId: 'p-2', stem: 'ACME_G2_H1_C1', identity: IDENTITY, versions: [v1, v2, v3], project},
    {projectId: 'p-3', stem: 'ACME_G3_H1', identity: g3, versions: [version(1, 'superado'), version(2, 'no disponible', {judge: {label: 'no disponible', error: 'the judge failed (exit 1)', at: AT}})], project: {identity: g3}},
    {projectId: 'p-4', stem: 'ACME_G2_H2_C1', identity: {...IDENTITY, variant: {hook: 2, cta: 1}}, versions: [], project: null},
  ];
  const items = ownerInbox(rows, {disk: {freeDiskMb: 2000, minDiskMb: 3072}});
  const by = (k) => items.filter((i) => i.kind === k).map((i) => i.text);
  assert.deepEqual(by('nota'), ['ACME_G2_H1_C1 v1 @0:20.4, de cesar (abierta): «la música tapa la voz»']);
  assert.equal(by('guion').length, 1);
  assert.match(by('guion')[0], /^ACME_G2_H1_C1: caption .*"70".*"60"/);
  assert.deepEqual(by('juez'), ['ACME_G3_H1 v2: QC técnico no disponible — the judge failed (exit 1) (re-juzgar, sin re-render)']);
  assert.deepEqual(by('rojos'), ['ACME_G2_H1_C1: 3 versiones seguidas con hallazgos (v1–v3) — mirar antes de otra vuelta']);
  assert.deepEqual(by('disco'), ['Disco bajo: 2.0 GB libres (piso de render 3.0 GB) — cleanup-exports --apply y la retención']);
  assert.deepEqual(by('metrica'), ['Notas en v1, ACME G2: ACME_G2_H1_C1 2', 'Notas en v1, ACME G3: ACME_G3_H1 0']);
  assert.equal(new Set(items.map((i) => i.key)).size, items.length, 'one key per item');
  // a judge down on an older version is history; two reds are not three; disk above the floor says nothing
  const calm = ownerInbox([{...rows[1], versions: [rows[1].versions[1], version(3)]}, {...rows[0], versions: [v2, v3], project: null}], {disk: {freeDiskMb: 9000, minDiskMb: 3072}});
  assert.deepEqual(calm.filter((i) => i.kind !== 'metrica' && i.kind !== 'nota'), []);
});
