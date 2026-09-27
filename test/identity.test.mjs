// Project identity {client, family, script, variant}: one set of rules (src/validate.ts) for the
// MCP's set_identity, the backend's POST /api/projects (400) and the editor's Settings tab; the
// uniqueness per client against the saved projects (mcp/checks.mjs); the system file names.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {DELIVERABLES, deliverableName, identityOf, identityTaken, validateIdentity} from '../src/validate.ts';
import {claimIdentity, identityWrite, pairIdentity} from '../mcp/checks.mjs';
import {backendStub} from './backend-stub.mjs';

const ok = (x) => { const r = validateIdentity(x); assert.equal(r.error, undefined, JSON.stringify(x)); return r.identity; };
const bad = (x, re) => { const r = validateIdentity(x); assert.equal(r.identity, null, JSON.stringify(x)); assert.match(r.error, re, JSON.stringify(x)); };

test('validateIdentity: normalizes a good identity (default family, variant keys in order, unknown keys dropped)', () => {
  const i = ok({client: 'acme', script: 2, variant: {cta: 1, hook: 1}, note: 'x'});
  assert.deepEqual(i, {client: 'acme', family: 'acme-G2', script: 2, variant: {hook: 1, cta: 1}});
  assert.deepEqual(Object.keys(i), ['client', 'family', 'script', 'variant']);
  assert.deepEqual(Object.keys(i.variant), ['hook', 'cta']);
  assert.equal(ok({client: 'acme', script: 2, family: 'Acme-Launch'}).family, 'Acme-Launch');
  assert.equal(ok({client: 'acme', script: 10, variant: {v: 2}}).variant.v, 2);
  assert.deepEqual(ok({client: 'casa-azul', script: 99, variant: {cta: 3}}).variant, {cta: 3});
  assert.equal(ok({client: 'a'.repeat(32), script: 1}).variant, null);
  // none at all: the project has no identity (it renders as before)
  assert.deepEqual(validateIdentity(null), {identity: null});
  assert.deepEqual(validateIdentity(undefined), {identity: null});
});

test('validateIdentity: rejects a bad client, script, variant or family with a clear reason', () => {
  for (const client of ['ACME', 'a'.repeat(33), '', 'ac me', 'a_b', '../x', 'acme.', 3]) bad({client, script: 2}, /^identity\.client: a slug/);
  for (const script of [0, 100, 1.5, '2', null, -1]) bad({client: 'acme', script}, /^identity\.script: a whole number 1–99/);
  for (const variant of [{}, {hook: 0}, {cta: -1}, {hook: 1.5}, {v: 1, hook: 1}, {x: 1}, [], [1], 'H1', 1]) bad({client: 'acme', script: 2, variant}, /^identity\.variant:/);
  // capped: past 2^53 a number prints as 1e+21 — a '+' in a file name
  for (const variant of [{hook: 1e21, cta: 1}, {cta: 1000}, {v: 2 ** 53}, {hook: Infinity}]) bad({client: 'acme', script: 2, variant}, /^identity\.variant: .*1–999/);
  assert.deepEqual(ok({client: 'acme', script: 2, variant: {hook: 999}}).variant, {hook: 999});
  for (const family of ['', 'a/b', 'x'.repeat(65), 7]) bad({client: 'acme', script: 2, family}, /^identity\.family:/);
  bad('acme', /^identity: an object/);
  bad([], /^identity: an object/);
});

test('validateIdentity: development (color-ref\'s references) is optional, trimmed, a name up to 60 characters', () => {
  assert.equal(ok({client: 'acme', script: 2, development: '  Montealbán 326 '}).development, 'Montealbán 326');
  assert.equal('development' in ok({client: 'acme', script: 2, development: ' '}), false);
  for (const development of ['x'.repeat(61), 'a\nb', 7]) bad({client: 'acme', script: 2, development}, /^identity\.development:/);
  assert.equal(identityOf({client: 'acme', script: 2, development: 'Thula'}).development, 'Thula');
});

test('identityOf: the flat fields of set_identity and the editor form → the variant from the numbers given', () => {
  assert.deepEqual(ok(identityOf({client: 'acme', script: 2, hook: 1, cta: 2})).variant, {hook: 1, cta: 2});
  assert.deepEqual(ok(identityOf({client: 'acme', script: 10, v: 2})).variant, {v: 2});
  assert.equal(ok(identityOf({client: 'acme', script: 2})).variant, null);
  assert.match(validateIdentity(identityOf({client: 'acme', script: 2, v: 1, hook: 1})).error, /identity\.variant/);
  assert.match(validateIdentity(identityOf({client: 'acme', script: 2, hook: NaN})).error, /identity\.variant/);
});

test('deliverableName: the system names by format — client in capitals, H / C only when they exist, V for a plain version, the PNG zip\'s two-part extension', () => {
  const I = (variant, script = 2) => ({client: 'acme', script, variant});
  assert.equal(deliverableName({identity: I({hook: 1, cta: 1}), v: 3, kind: 'master', ext: 'mp4'}), 'ACME_G2_H1_C1_v3_master.mp4');
  assert.equal(deliverableName({identity: I({hook: 2, cta: 2}), v: 1, kind: 'captions', ext: 'mov'}), 'ACME_G2_H2_C2_v1_captions.mov');
  assert.equal(deliverableName({identity: I({v: 2}, 10), v: 1, kind: 'master', ext: 'mp4'}), 'ACME_G10_V2_v1_master.mp4');
  assert.equal(deliverableName({identity: I(null), v: 1, kind: 'master', ext: 'mp4'}), 'ACME_G2_v1_master.mp4');
  assert.equal(deliverableName({identity: I({hook: 4}), v: 1, kind: 'master', ext: 'mp4'}), 'ACME_G2_H4_v1_master.mp4');
  assert.equal(deliverableName({identity: I({cta: 2}), v: 12, kind: 'captions', ext: 'mov'}), 'ACME_G2_C2_v12_captions.mov');
  assert.equal(deliverableName({identity: I({v: 2}, 10), v: 1, kind: 'captions', ext: 'png.zip'}), 'ACME_G10_V2_v1_captions.png.zip');
  assert.deepEqual(DELIVERABLES.map(({kind, ext}) => deliverableName({identity: I({hook: 1, cta: 2}), v: 3, kind, ext})),
    ['ACME_G2_H1_C2_v3_master.mp4', 'ACME_G2_H1_C2_v3_captions.mov', 'ACME_G2_H1_C2_v3_captions.png.zip', 'ACME_G2_H1_C2_v3_supers.mov', 'ACME_G2_H1_C2_v3_master_supers.mp4']);
  assert.equal(deliverableName({identity: {client: 'casa-azul', script: 1}, v: 1, kind: 'master', ext: 'mp4'}), 'CASA-AZUL_G1_v1_master.mp4');
  // never a path: no character outside [A-Za-z0-9_.-], an extension of one or two parts, no '..'
  for (const a of [{kind: '../x'}, {kind: 'a/b'}, {kind: 'a.b'}, {ext: 'a/b'}, {ext: 'mp4.'}, {ext: '.mp4'}, {ext: 'png..zip'}, {ext: 'a.b.c'}, {ext: ''}, {v: 0}, {v: 1.5}, {v: '1'}, {v: 1e21}]) {
    assert.throws(() => deliverableName({identity: I({hook: 1, cta: 1}), v: 1, kind: 'master', ext: 'mp4', ...a}), /deliverable/, JSON.stringify(a));
  }
  assert.throws(() => deliverableName({identity: null, v: 1, kind: 'master', ext: 'mp4'}), /identity/);
  assert.throws(() => deliverableName({identity: {client: '../etc', script: 2}, v: 1, kind: 'master', ext: 'mp4'}), /identity\.client/);
  for (const variant of [null, {hook: 1}, {cta: 99}, {v: 7}, {hook: 3, cta: 4}]) {
    const n = deliverableName({identity: {client: 'a-b-9', script: 99, variant}, v: 100, kind: 'captions', ext: 'mov'});
    assert.match(n, /^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/);
    assert.match(deliverableName({identity: {client: 'a-b-9', script: 99, variant}, v: 100, kind: 'captions', ext: 'png.zip'}), /^[A-Za-z0-9_-]+\.png\.zip$/);
    assert.ok(!n.includes('..'));
  }
});

test('identityTaken: one project per client, script and variant — key order and other fields do not matter', () => {
  const rows = [
    {id: 'a', identity: {client: 'acme', family: 'x', script: 2, variant: {cta: 1, hook: 1}}},
    {id: 'b', identity: {client: 'acme', script: 3}},
    {id: 'junk', identity: {client: 'NOPE'}},
    {id: 'none'},
  ];
  const I = (x) => ok({client: 'acme', script: 2, ...x});
  assert.match(identityTaken(rows, 'c', I({variant: {hook: 1, cta: 1}})), /identity ACME_G2_H1_C1 is already project a/);
  assert.equal(identityTaken(rows, 'a', I({variant: {hook: 1, cta: 1}})), null); // itself
  assert.equal(identityTaken(rows, 'c', I({variant: {hook: 1}})), null);
  assert.equal(identityTaken(rows, 'c', I({variant: {hook: 2, cta: 1}})), null);
  assert.equal(identityTaken(rows, 'c', I({client: 'otro', variant: {hook: 1, cta: 1}})), null); // per client
  assert.match(identityTaken(rows, 'c', ok({client: 'acme', script: 3})), /already project b/);
  assert.equal(identityTaken(rows, 'c', ok({client: 'acme', script: 3, variant: {v: 1}})), null);
});

test('claimIdentity / identityWrite: checked against the saved projects; a save that leaves it alone passes untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-identity-'));
  try {
    const A = {client: 'acme', family: 'acme-G2', script: 2, variant: {hook: 1, cta: 1}};
    fs.writeFileSync(path.join(dir, 'p1.json'), JSON.stringify({name: 'one', identity: A}));
    fs.writeFileSync(path.join(dir, 'p2.json'), JSON.stringify({name: 'two'}));
    fs.writeFileSync(path.join(dir, 'broken.json'), '{nope');
    fs.writeFileSync(path.join(dir, 'p1.timing.jsonl'), '{}');
    assert.match(claimIdentity(dir, 'p2', {client: 'acme', script: 2, variant: {cta: 1, hook: 1}}).error, /already project p1/);
    assert.deepEqual(claimIdentity(dir, 'p1', A), {identity: A});
    assert.deepEqual(claimIdentity(dir, 'p2', {client: 'acme', script: 2, variant: {hook: 2}}).identity, {client: 'acme', family: 'acme-G2', script: 2, variant: {hook: 2}});
    assert.match(claimIdentity(dir, 'p2', {client: 'Acme', script: 2}).error, /identity\.client/);
    assert.deepEqual(claimIdentity(dir, 'p2', null), {identity: null});

    // R-2: a body without identity, or with the saved one, is not checked and gains no field
    const plain = {name: 'x', clips: []};
    assert.equal(identityWrite(dir, 'p2', {name: 'two'}, plain), null);
    assert.ok(!('identity' in plain));
    const same = {identity: {...A}};
    assert.equal(identityWrite(dir, 'p1', {identity: A}, same), null);
    // a new or changed identity: 400 when bad or repeated, normalized in place when good
    assert.match(identityWrite(dir, 'p2', {}, {identity: {client: 'acme', script: 2, variant: {hook: 1, cta: 1}}}), /identity ACME_G2_H1_C1 is already project p1/);
    assert.match(identityWrite(dir, 'p2', {}, {identity: {client: 'acme', script: 0}}), /identity\.script/);
    const fresh = {identity: {client: 'acme', script: 3}};
    assert.equal(identityWrite(dir, 'p2', {}, fresh), null);
    assert.deepEqual(fresh.identity, {client: 'acme', family: 'acme-G3', script: 3, variant: null});
    const cleared = {identity: null};
    assert.equal(identityWrite(dir, 'p1', {identity: A}, cleared), null);
    assert.equal(cleared.identity, null);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

// ---------- the MCP tool, end to end on throwaway project files ----------
// api: the backend the MCP saves through — the stub of its project write (test/backend-stub.mjs) unless given
const PROJECTS = path.join('public', 'projects');
async function withMcp(api, fn) {
  const backend = api ? null : await backendStub();
  const tag = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const ids = ['a', 'b', 'c'].map((x) => `p-idtest-${tag}-${x}`);
  fs.mkdirSync(PROJECTS, {recursive: true});
  for (const id of ids) fs.writeFileSync(path.join(PROJECTS, `${id}.json`), JSON.stringify({name: `identity test ${id}`, clips: [], captions: [], brolls: [], graphics: []}));
  const client = new Client({name: 'test', version: '0'});
  await client.connect(new StdioClientTransport({command: 'node', args: ['mcp/server.mjs'], cwd: process.cwd(), env: {...process.env, REEL_API: api ?? backend.url, REEL_AGENT: 'identity-test'}}));
  const call = async (name, args) => { const r = await client.callTool({name, arguments: args}); return {err: !!r.isError, text: r.content.map((c) => c.text ?? '').join('\n')}; };
  const saved = (id) => JSON.parse(fs.readFileSync(path.join(PROJECTS, `${id}.json`), 'utf8'));
  const made = [];
  try { await fn({call, saved, ids, made, client: `t${process.pid}`}); } finally {
    await client.close(); await backend?.close();
    for (const id of [...ids, ...made]) for (const ext of ['.json', '.lock', '.timing.jsonl']) fs.rmSync(path.join(PROJECTS, id + ext), {force: true});
  }
}

test('pairIdentity (POST /api/render): the saved project\'s identity, normalized; none → null (a render as before); a bad one throws (400)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-identity-'));
  try {
    fs.writeFileSync(path.join(dir, 'p1.json'), JSON.stringify({name: 'one', identity: {client: 'acme', script: 2, variant: {cta: 1, hook: 1}}}));
    fs.writeFileSync(path.join(dir, 'p2.json'), JSON.stringify({name: 'two'}));
    fs.writeFileSync(path.join(dir, 'p3.json'), JSON.stringify({identity: {client: 'ACME', script: 2}}));
    assert.deepEqual(pairIdentity(dir, 'p1'), {client: 'acme', family: 'acme-G2', script: 2, variant: {hook: 1, cta: 1}});
    assert.equal(pairIdentity(dir, 'p2'), null);
    assert.equal(pairIdentity(dir, 'gone'), null);
    assert.throws(() => pairIdentity(dir, 'p3'), /identity\.client/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('MCP set_identity: validates, keeps one project per client + script + variant, names the files; clear and duplicate', async () => {
  await withMcp(null, async ({call, saved, ids: [a, b, c], made, client}) => {
    const up = client.toUpperCase();
    const r = await call('set_identity', {project_id: a, client, script: 2, hook: 1, cta: 1});
    assert.equal(r.err, false, r.text);
    assert.match(r.text, new RegExp(`${up}_G2_H1_C1_v1_master\\.mp4.*${up}_G2_H1_C1_v1_captions\\.mov`));
    assert.deepEqual(saved(a).identity, {client, family: `${client}-G2`, script: 2, variant: {hook: 1, cta: 1}});
    assert.match((await call('get_project', {project_id: a})).text, new RegExp(`IDENTITY \\(set_identity\\): ${up}_G2_H1_C1_v1_master\\.mp4`));

    // the same client, script and variant on another project: refused, nothing written
    const dup = await call('set_identity', {project_id: b, client, script: 2, cta: 1, hook: 1});
    assert.ok(dup.err && new RegExp(`already project ${a}`).test(dup.text), dup.text);
    assert.ok(!('identity' in saved(b)));
    const badSlug = await call('set_identity', {project_id: b, client: 'ACME', script: 2});
    assert.ok(badSlug.err && /identity\.client: a slug/.test(badSlug.text), badSlug.text);
    const mixed = await call('set_identity', {project_id: b, client, script: 2, v: 1, hook: 1});
    assert.ok(mixed.err && /identity\.variant/.test(mixed.text), mixed.text);
    // another variant of the same script is fine; so is a plain V
    assert.equal((await call('set_identity', {project_id: b, client, script: 2, hook: 2, cta: 2})).err, false);
    const v2 = await call('set_identity', {project_id: c, client, script: 10, v: 2, family: 'launch'});
    assert.match(v2.text, new RegExp(`${up}_G10_V2_v1_master\\.mp4`));
    assert.equal(saved(c).identity.family, 'launch');

    // duplicate_project leaves the identity behind (a copy is another variant, or none)
    const d = await call('duplicate_project', {project_id: a});
    const copy = d.text.match(/Created (p-\d+)/)[1]; made.push(copy);
    assert.match(d.text, /identity not copied/);
    assert.ok(!('identity' in saved(copy)));

    // clear: the identity goes, the project renders as before
    assert.match((await call('set_identity', {project_id: a, clear: true})).text, /Identity removed/);
    assert.equal(saved(a).identity, null);
    assert.equal((await call('set_identity', {project_id: b, client, script: 2, hook: 1, cta: 1})).err, false); // free again
  });
});

test('R-2: an edit of a project without identity writes no identity field', async () => {
  await withMcp(null, async ({call, saved, ids: [a]}) => {
    assert.equal((await call('set_accent_color', {project_id: a, color: '#00FF00'})).err, false);
    assert.equal(saved(a).accentColor, '#00FF00');
    assert.ok(!('identity' in saved(a)));
    assert.doesNotMatch((await call('get_project', {project_id: a})).text, /IDENTITY/);
  });
});

test('a 400 from the backend (POST /api/projects: bad or repeated identity) reaches the agent and nothing is written around it', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      seen.push([req.method, req.url]);
      // what server/index.mjs answers when identityWrite refuses the body
      const r = identityWrite(PROJECTS, req.url.split('/').pop(), {}, {identity: {client: 'nope', script: 0}});
      res.writeHead(400, {'content-type': 'application/json'}).end(JSON.stringify({error: r, code: 'bad_identity'}));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    await withMcp(`http://127.0.0.1:${srv.address().port}`, async ({call, saved, ids: [a], client}) => {
      const r = await call('set_identity', {project_id: a, client, script: 2, hook: 1});
      assert.ok(r.err && /not saved: the backend refused the project \(400\): identity\.script: a whole number 1–99/.test(r.text), r.text);
      assert.deepEqual(seen, [['POST', `/api/projects/${a}`]]);
      assert.ok(!('identity' in saved(a))); // no direct write behind the backend's back
    });
  } finally { srv.close(); }
});

test('T1: the backend down, an edit fails and the project file is not touched (no direct write)', async () => {
  await withMcp('http://127.0.0.1:9', async ({call, saved, ids: [a]}) => {
    const before = fs.readFileSync(path.join(PROJECTS, `${a}.json`), 'utf8');
    const r = await call('set_accent_color', {project_id: a, color: '#00FF00'});
    assert.ok(r.err && /not saved: the reel-agent backend is not running at http:\/\/127\.0\.0\.1:9/.test(r.text), r.text);
    assert.equal(fs.readFileSync(path.join(PROJECTS, `${a}.json`), 'utf8'), before);
    assert.equal(saved(a).accentColor, undefined);
  });
});

test('T1: a 401 or a 500 from the backend fails the edit with its status and reason, and the project file is not touched', async () => {
  const codes = [401, 500];
  const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => res.writeHead(codes.shift(), {'content-type': 'application/json'}).end(JSON.stringify({error: 'nope'}))); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    await withMcp(`http://127.0.0.1:${srv.address().port}`, async ({call, ids: [a]}) => {
      const before = fs.readFileSync(path.join(PROJECTS, `${a}.json`), 'utf8');
      for (const code of [401, 500]) {
        const r = await call('set_accent_color', {project_id: a, color: '#00FF00'});
        assert.ok(r.err && r.text.includes(`not saved: the backend refused the project (${code}): nope`), r.text);
        assert.equal(fs.readFileSync(path.join(PROJECTS, `${a}.json`), 'utf8'), before);
      }
    });
  } finally { srv.close(); }
});
