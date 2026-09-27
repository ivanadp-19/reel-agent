// Import from Google Drive (server/drive.mjs) against a fake Drive: the token endpoint (checks the JWT with the
// service account's public key), files.list with pages, files.get and alt=media with Range. No real credential.
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {Writable} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {createDrive, createDriveImport, proposeTake, readKey, safeName, signJwt, takeFits, SCOPE} from '../server/drive.mjs';
import {createClipIngest} from '../server/ingest.mjs';
import {partFile, partSize} from '../server/uploads.mjs';
import {parseStem} from '../src/validate.ts';
import {main} from '../cli/reel.mjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-drive-'));
const pub = path.join(dir, 'public');
const uploads = path.join(dir, '.uploads');
fs.mkdirSync(path.join(pub, 'projects'), {recursive: true});
const {privateKey, publicKey} = crypto.generateKeyPairSync('rsa', {modulusLength: 2048, privateKeyEncoding: {type: 'pkcs8', format: 'pem'}, publicKeyEncoding: {type: 'spki', format: 'pem'}});
const EMAIL = 'reel-import@test-project.iam.gserviceaccount.com';
const keyFile = path.join(dir, 'secrets', 'sa.json');
fs.mkdirSync(path.dirname(keyFile), {recursive: true});
fs.writeFileSync(keyFile, JSON.stringify({type: 'service_account', client_email: EMAIL, private_key: privateKey, private_key_id: 'k1'}), {mode: 0o600});
const KEY_MARK = privateKey.split('\n')[5]; // a line from the middle of the PEM: in no response, error or log

// ---- the fake Drive ----
const video = (name) => {
  const f = path.join(dir, `${name}.mp4`);
  if (hasFfmpeg) spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=1', '-f', 'lavfi', '-i', 'sine=duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-metadata', `title=${name}`, '-shortest', f]);
  else fs.writeFileSync(f, crypto.randomBytes(300e3));
  return fs.readFileSync(f);
};
const T = '2026-09-20T10:00:00.000Z';
const FILES = {}; // id → {name, mimeType, bytes, modifiedTime, folder}
const add = (id, name, folder = 'F1', bytes = video(id), mimeType = 'video/mp4') => (FILES[id] = {id, name, mimeType, bytes, modifiedTime: T, folder});
add('hookId', 'g02-hook.mp4');
add('bodyId', 'g02-body.mp4');
add('closeId', 'g02-close.mp4');
add('nastyId', '../../etc/\u001b[31mG2 H1\u202e.mp4');
add('docId', 'Guion G2', 'F1', Buffer.from('doc'), 'application/vnd.google-apps.document');
add('otherId', 'G3_V2.mp4', 'F2');
const drv = {tokens: 0, media: [], revoked: false, limited: {}, cut: new Set(), swap: {}, assertions: []}; // swap: id → what the file becomes when its cut download breaks off
let fake, api, tokenUrl;
const sendJson = (res, code, obj, headers = {}) => { res.writeHead(code, {'content-type': 'application/json', ...headers}); res.end(JSON.stringify(obj)); };
function fakeDrive(req, res) {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'POST' && u.pathname === '/token') {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      drv.tokens++;
      const form = new URLSearchParams(b);
      const [h, c, sig] = String(form.get('assertion')).split('.');
      drv.assertions.push(form.get('assertion'));
      const ok = form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer' && crypto.verify('sha256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig ?? '', 'base64url'));
      ok ? sendJson(res, 200, {access_token: 'ya29.fake', expires_in: 3600, token_type: 'Bearer'}) : sendJson(res, 400, {error: 'invalid_grant', error_description: 'Invalid JWT Signature.'});
    });
    return;
  }
  if (req.headers.authorization !== 'Bearer ya29.fake' || drv.revoked) return sendJson(res, 401, {error: {code: 401, status: 'UNAUTHENTICATED', errors: [{reason: 'authError'}]}});
  if (u.pathname === '/drive/v3/files') {
    const folder = u.searchParams.get('q').match(/^'([\w-]+)' in parents and trashed=false$/)?.[1];
    if (folder === 'denied') return sendJson(res, 403, {error: {code: 403, errors: [{reason: 'insufficientFilePermissions'}]}});
    const all = Object.values(FILES).filter((f) => f.folder === folder).map(({bytes, folder: _, ...f}) => ({...f, ...(f.mimeType.startsWith('video/') ? {size: String(bytes.length)} : {})}));
    if (!all.length) return sendJson(res, 404, {error: {code: 404, errors: [{reason: 'notFound'}]}});
    const at = +(u.searchParams.get('pageToken') || 0); // two per page: the client must follow nextPageToken
    return sendJson(res, 200, {files: all.slice(at, at + 2), ...(at + 2 < all.length ? {nextPageToken: String(at + 2)} : {})});
  }
  const id = u.pathname.match(/^\/drive\/v3\/files\/([\w-]+)$/)?.[1];
  const f = FILES[id];
  if (!f) return sendJson(res, 404, {error: {code: 404, errors: [{reason: 'notFound'}]}});
  if (u.searchParams.get('alt') !== 'media') return sendJson(res, 200, {id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, size: String(f.bytes.length), md5Checksum: crypto.createHash('md5').update(f.bytes).digest('hex')});
  drv.media.push({id, range: req.headers.range ?? null});
  if (drv.limited[id] > 0) { drv.limited[id]--; return sendJson(res, 429, {error: {code: 429, errors: [{reason: 'rateLimitExceeded'}]}}, {'retry-after': '2'}); }
  const from = +(req.headers.range?.match(/^bytes=(\d+)-$/)?.[1] ?? 0);
  const body = f.bytes.subarray(from);
  res.writeHead(req.headers.range ? 206 : 200, {'content-type': 'video/mp4', 'content-length': body.length, ...(req.headers.range ? {'content-range': `bytes ${from}-${f.bytes.length - 1}/${f.bytes.length}`} : {})});
  if (drv.cut.has(id)) { // the connection dies halfway (and the file is replaced on Drive meanwhile, when swap says so)
    drv.cut.delete(id); res.write(body.subarray(0, Math.floor(body.length / 2)));
    if (drv.swap[id]) { Object.assign(f, drv.swap[id]); delete drv.swap[id]; }
    setTimeout(() => res.socket.destroy(), 50); return;
  }
  res.end(body);
}

// ---- the backend's routes over a temp public/ (server/drive.mjs + the real clip ingest) ----
const logs = [];
const bodies = []; // every answer of the routes, to look for the key in
let srv, base, free = Infinity;
const sleeps = [];
const drive = (o = {}) => createDrive({keyFile, publicDir: pub, api, tokenUrl, sleep: async (ms) => { sleeps.push(ms); }, ...o});
before(async () => {
  fake = http.createServer(fakeDrive);
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  api = `http://127.0.0.1:${fake.address().port}/drive/v3`;
  tokenUrl = `http://127.0.0.1:${fake.address().port}/token`;
  const ingest = createClipIngest({publicDir: pub, root: dir, token: 'tok', uploadsDir: uploads, log: (l) => logs.push(l)});
  const imp = createDriveImport({drive: drive(), publicDir: pub, uploadsDir: uploads, ingestPart: ingest.ingestPart, freeBytes: () => free, minFreeBytes: 2 ** 20, log: (l) => logs.push(l)});
  srv = http.createServer(async (req, res) => {
    const end = res.end.bind(res);
    res.end = (b) => { if (b) bodies.push(String(b)); return end(b); };
    const url = new URL(req.url, 'http://x');
    const pj = req.method === 'GET' && url.pathname.match(/^\/api\/projects\/([\w-]+)$/)?.[1]; // what the reel CLI reads
    if (pj) { const f = path.join(pub, 'projects', `${pj}.json`); return fs.existsSync(f) ? sendJson(res, 200, JSON.parse(fs.readFileSync(f, 'utf8'))) : sendJson(res, 404, {error: 'not found', code: 'not_found'}); }
    if (!(await imp.handle(req, res, url, {via: 'loopback'}))) sendJson(res, 404, {error: 'no route'});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv?.close(); fake?.close(); fs.rmSync(dir, {recursive: true, force: true}); });

const project = (id, extra = {}) => fs.writeFileSync(path.join(pub, 'projects', `${id}.json`), JSON.stringify({name: id, clips: [], captions: [], updatedAt: '2026-09-27T00:00:00.000Z', ...extra}));
const readP = (id) => JSON.parse(fs.readFileSync(path.join(pub, 'projects', `${id}.json`), 'utf8'));
const call = async (method, route, b) => { const r = await fetch(`${base}${route}`, {method, ...(b ? {body: JSON.stringify(b)} : {})}); return {status: r.status, body: await r.json()}; };
async function importJob(b) {
  const r = await call('POST', '/api/drive/import', b);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  for (const t0 = Date.now(); ;) {
    const s = (await call('GET', `/api/drive/import/${r.body.jobId}`)).body;
    if (s.status !== 'running') return s;
    assert.ok(Date.now() - t0 < 60e3, 'the import job did not finish');
    await new Promise((res) => setTimeout(res, 30));
  }
}

// ---- auth ----
test('the JWT: RS256 header, the service account as iss, drive.readonly, aud = the token URL, an hour — verifiable with its public key', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  const jwt = signJwt({client_email: EMAIL, private_key: privateKey}, {aud: 'https://oauth2.googleapis.com/token', now});
  const [h, c, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), {alg: 'RS256', typ: 'JWT'});
  assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url')), {iss: EMAIL, scope: 'https://www.googleapis.com/auth/drive.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now / 1000, exp: now / 1000 + 3600});
  assert.equal(SCOPE, 'https://www.googleapis.com/auth/drive.readonly');
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig, 'base64url')), 'the signature verifies');
  const forged = Buffer.from(JSON.stringify({iss: EMAIL, scope: 'https://www.googleapis.com/auth/drive', aud: 'x', iat: 0, exp: 1})).toString('base64url');
  assert.ok(!crypto.verify('sha256', Buffer.from(`${h}.${forged}`), publicKey, Buffer.from(sig, 'base64url')), 'other claims do not');
});

test('the access token is minted once and kept in memory until it expires', async () => {
  let now = Date.parse('2026-09-27T12:00:00Z');
  const d = drive({now: () => now});
  const t0 = drv.tokens;
  await d.list('F1');
  await d.list('F1');
  assert.equal(drv.tokens - t0, 1);
  now += 3600e3; // past expires_in (minus a minute)
  await d.list('F1');
  assert.equal(drv.tokens - t0, 2);
  const jwt = drv.assertions.at(-1).split('.');
  assert.equal(JSON.parse(Buffer.from(jwt[1], 'base64url')).aud, tokenUrl, 'aud is the token endpoint it is sent to');
});

test('the key: not set, unreadable, readable by others, or under public/ → DriveAuth that names neither the path nor the key', async () => {
  const cases = [[undefined, /not set up/], [path.join(dir, 'secrets', 'missing.json'), /cannot be read/]];
  const loose = path.join(dir, 'secrets', 'loose.json');
  fs.copyFileSync(keyFile, loose);
  fs.chmodSync(loose, 0o644);
  cases.push([loose, /chmod 600/]);
  const inPublic = path.join(pub, 'sa.json');
  fs.copyFileSync(keyFile, inPublic);
  fs.chmodSync(inPublic, 0o600);
  cases.push([inPublic, /outside public/]);
  // a private_key that does not parse (truncated, a hand edit leaving literal \n, a passphrase) or is not RSA: DriveAuth
  // when read — not a network failure at signing, nor an ECDSA signature under an RS256 header
  const gen = (type, o = {}) => crypto.generateKeyPairSync(type, {...o, privateKeyEncoding: {type: 'pkcs8', format: 'pem', ...o.enc}, publicKeyEncoding: {type: 'spki', format: 'pem'}}).privateKey;
  for (const [n, pk, why] of [['truncated', privateKey.slice(0, 400), /not a usable private key/], ['escaped', privateKey.replace(/\n/g, '\\n'), /not a usable private key/],
    ['encrypted', gen('rsa', {modulusLength: 2048, enc: {cipher: 'aes-256-cbc', passphrase: 'pw'}}), /not a usable private key/], ['ec', gen('ec', {namedCurve: 'P-256'}), /not an RSA key/]]) {
    const f = path.join(dir, 'secrets', `${n}.json`);
    fs.writeFileSync(f, JSON.stringify({client_email: EMAIL, private_key: pk}), {mode: 0o600});
    cases.push([f, why]);
  }
  const t0 = drv.tokens;
  for (const [file, why] of cases) {
    const e = await drive({keyFile: file}).list('F1').then(() => null, (x) => x);
    assert.equal(e?.name, 'DriveAuth', String(file));
    assert.equal(e.code, 'drive_auth');
    assert.match(e.message, why);
    for (const s of [file ?? '\0', 'secrets', KEY_MARK, EMAIL]) assert.ok(!e.message.includes(s), `${e.message} names ${s}`);
  }
  assert.equal(drv.tokens, t0, 'no bad key reached the token endpoint');
  fs.rmSync(inPublic);
  assert.deepEqual(Object.keys(readKey(keyFile, pub)).sort(), ['client_email', 'private_key']);
});

test('401 / 403 → DriveAuth at once (no retry); a key Google does not accept → DriveAuth', async () => {
  const d = drive();
  await d.list('F1'); // a token in the cache
  drv.revoked = true;
  const n0 = drv.media.length, t0 = sleeps.length;
  const e = await d.get('hookId').then(() => null, (x) => x);
  drv.revoked = false;
  assert.equal(e?.name, 'DriveAuth');
  assert.match(e.message, /401/);
  assert.equal(sleeps.length, t0, 'no backoff, no retry');
  assert.equal(drv.media.length, n0);
  const denied = await d.list('denied').then(() => null, (x) => x);
  assert.equal(denied?.name, 'DriveAuth');
  assert.match(denied.message, /403 insufficientFilePermissions.*share the folder/);
  // a key whose signature the token endpoint rejects (another key under the same name)
  const other = crypto.generateKeyPairSync('rsa', {modulusLength: 2048, privateKeyEncoding: {type: 'pkcs8', format: 'pem'}, publicKeyEncoding: {type: 'spki', format: 'pem'}}).privateKey;
  const wrong = path.join(dir, 'secrets', 'wrong.json');
  fs.writeFileSync(wrong, JSON.stringify({client_email: EMAIL, private_key: other}), {mode: 0o600});
  const bad = await drive({keyFile: wrong}).list('F1').then(() => null, (x) => x);
  assert.equal(bad?.name, 'DriveAuth');
  assert.match(bad.message, /400 invalid_grant/);
});

test('404 → NotFound (a file, a folder)', async () => {
  const d = drive();
  for (const p of [d.get('nopeId'), d.list('nope'), d.list('https://drive.google.com/drive/folders/nope?usp=sharing')]) {
    const e = await p.then(() => null, (x) => x);
    assert.equal(e?.name, 'NotFound');
    assert.equal(e.code, 'not_found');
    assert.equal(e.status, 404);
  }
  await assert.rejects(d.list("x' or name contains 'a"), {code: 'bad_request'}, 'a folder id never reaches the query unchecked');
});

test('files.list follows every page', async () => {
  const {folder, files} = await drive().list('https://drive.google.com/drive/folders/F1?usp=sharing');
  assert.equal(folder, 'F1');
  assert.deepEqual(files.map((f) => f.id).sort(), ['bodyId', 'closeId', 'docId', 'hookId', 'nastyId']);
});

test('429 → backoff honoring Retry-After, up to 3 retries; a 4th 429 → RateLimit', async () => {
  const d = drive();
  const dest = path.join(dir, 'p429.part');
  drv.limited.bodyId = 3;
  sleeps.length = 0;
  await d.download({id: 'bodyId', name: 'g02-body.mp4', size: FILES.bodyId.bytes.length}, dest);
  assert.deepEqual(sleeps, [2000, 2000, 2000], 'Retry-After: 2 → 2 s each time');
  assert.ok(fs.readFileSync(dest).equals(FILES.bodyId.bytes));
  drv.limited.bodyId = 4;
  fs.rmSync(dest);
  const e = await d.download({id: 'bodyId', name: 'g02-body.mp4', size: FILES.bodyId.bytes.length}, dest).then(() => null, (x) => x);
  assert.equal(e?.name, 'RateLimit');
  assert.equal(e.code, 'rate_limited');
  assert.equal(drv.limited.bodyId, 0, '4 requests, then it gave up');
});

test('a download cut halfway resumes from the .part with Range — in the same job, and after a restart', async () => {
  const size = FILES.closeId.bytes.length, f = {id: 'closeId', name: 'g02-close.mp4', size};
  // same job: the retry asks for the rest
  let dest = path.join(dir, 'cut1.part');
  drv.cut.add('closeId');
  let n0 = drv.media.length;
  await drive().download(f, dest);
  let reqs = drv.media.slice(n0);
  assert.equal(reqs.length, 2);
  assert.equal(reqs[0].range, null);
  assert.match(reqs[1].range, /^bytes=\d+-$/);
  assert.ok(+reqs[1].range.slice(6, -1) > 0);
  assert.ok(fs.readFileSync(dest).equals(FILES.closeId.bytes), 'the bytes are the file');
  // a backend killed mid-download: the part stays; the next backend's import goes on from it
  dest = path.join(dir, 'cut2.part');
  drv.cut.add('closeId');
  const e = await drive({retries: 0}).download(f, dest).then(() => null, (x) => x);
  assert.equal(e?.code, 'drive_unreachable');
  assert.match(e.message, /import again/);
  const have = partSize(dest);
  assert.ok(have > 0 && have < size, `the part kept ${have} of ${size} bytes`);
  n0 = drv.media.length;
  await drive().download(f, dest);
  reqs = drv.media.slice(n0);
  assert.deepEqual(reqs.map((r) => r.range), [`bytes=${have}-`]);
  assert.ok(fs.readFileSync(dest).equals(FILES.closeId.bytes));
  // a complete part: no request at all
  n0 = drv.media.length;
  await drive().download(f, dest);
  assert.equal(drv.media.length, n0);
});

test('a file replaced on Drive between a cut and its resume: the spliced part fails its md5, removed — never ingested', async () => {
  const A = crypto.randomBytes(32081), B = crypto.randomBytes(32081); // same size, other bytes
  add('swapId', 'g02-swap.mp4', 'F3', A);
  const d = drive();
  const meta = await d.get('swapId');
  drv.cut.add('swapId');
  drv.swap.swapId = {bytes: B, modifiedTime: '2026-09-21T10:00:00.000Z'};
  const dest = path.join(dir, 'swap.part');
  const e = await d.download({...meta, id: 'swapId'}, dest).then(() => null, (x) => x);
  assert.equal(e?.code, 'drive_changed');
  assert.match(e.message, /changed on Drive during the download.*import again/);
  assert.ok(!fs.existsSync(dest), 'the spliced part is removed');
  // in a job: that file fails alone, nothing reaches the timeline; the next import sees the new revision (a new key)
  FILES.swapId.bytes = A; FILES.swapId.modifiedTime = T;
  drv.cut.add('swapId');
  drv.swap.swapId = {bytes: B, modifiedTime: '2026-09-21T10:00:00.000Z'};
  project('p-swap');
  const s = await importJob({project_id: 'p-swap', files: [{fileId: 'swapId', script: 2}]});
  assert.deepEqual([s.status, s.code, s.failed.map((f) => f.fileId), s.added.length], ['error', 'drive_changed', ['swapId'], 0]);
  assert.deepEqual(readP('p-swap').clips, []);
  assert.deepEqual(fs.readdirSync(uploads).filter((f) => f.endsWith('.part')), [], 'no part left to resume from');
});

test('ENOSPC while writing the part → LowDisk, the partial file removed', async () => {
  const dest = path.join(dir, 'full.part');
  const full = (file) => new Writable({write(c, _e, cb) { fs.appendFileSync(file, c); cb(Object.assign(new Error('ENOSPC: no space left on device, write'), {code: 'ENOSPC'})); }});
  const e = await drive().download({id: 'hookId', name: 'g02-hook.mp4', size: FILES.hookId.bytes.length}, dest, {write: full}).then(() => null, (x) => x);
  assert.equal(e?.name, 'LowDisk');
  assert.equal(e.code, 'low_disk');
  assert.equal(e.status, 507);
  assert.match(e.message, /disk full while downloading g02-hook\.mp4/);
  assert.ok(!fs.existsSync(dest));
});

// ---- the mapping ----
test('the take a name proposes: César\'s names; the user confirms it', () => {
  const t = (n) => proposeTake(n).stem ?? JSON.stringify(proposeTake(n).variant);
  assert.equal(t('g02-hook.mp4'), 'G2_H1');
  assert.equal(t('g02-body.mp4'), 'G2');
  assert.equal(t('g02-close.mp4'), 'G2_C1');
  assert.equal(t('G2 H1.mov'), 'G2_H1');
  assert.equal(t('CTA1.mp4'), '{"cta":1}', 'a CTA with no script in the name: the script is the user\'s');
  assert.equal(proposeTake('CTA1.mp4').script, null);
  assert.equal(t('Guion3_2.mp4'), 'G3_V2');
  assert.equal(t('Guión 4 gancho 2.mov'), 'G4_H2');
  assert.equal(t('G10_V1_master_sin_captions_v2.mp4'), 'G10_V1');
  assert.equal(t('G1_CAPTIONED_v11.1_fromCleanV2.mp4'), 'G1', 'a render version is not a variant');
  assert.deepEqual(proposeTake('IMG_0227.MOV'), {script: null, variant: null, stem: null});
  assert.deepEqual(parseStem('g2_h1'), {script: 2, variant: {hook: 1}});
  assert.deepEqual(parseStem('G2'), {script: 2, variant: null});
  assert.equal(parseStem('G2_H1_V2'), null);
  const id = {client: 'vibem', script: 2, variant: {hook: 1, cta: 1}};
  assert.equal(takeFits({script: 2, variant: null}, id), null, 'the body is every variant\'s');
  assert.equal(takeFits({script: 2, variant: {hook: 1}}, id), null);
  assert.match(takeFits({script: 2, variant: {hook: 2}}, id), /another variant's take, not VIBEM_G2_H1_C1/);
  assert.match(takeFits({script: 3, variant: null}, id), /another script/);
  assert.equal(takeFits({script: 3, variant: {v: 2}}, null), null, 'no identity: anything');
});

test('file names are untrusted: sanitized for display and labels, never a path', () => {
  const n = safeName('../../etc/\u001b[31mG2 H1\u202e.mp4');
  assert.ok(!/[/\\\u0000-\u001f\u202e]/.test(n) && !n.startsWith('.'), n);
  assert.equal(safeName(''), 'drive-file');
  assert.ok(safeName('a'.repeat(500)).length <= 120);
});

// ---- the routes and the job ----
test('list: the folder\'s videos with a proposed take, and whether each fits the project', async () => {
  project('p-list', {identity: {client: 'vibem', family: 'vibem-G2', script: 2, variant: {hook: 1, cta: 1}}});
  const r = await call('GET', '/api/drive/list?folder=F1&project=p-list');
  assert.equal(r.status, 200);
  assert.equal(r.body.others, 1, 'the Google Doc is not a video');
  const by = Object.fromEntries(r.body.files.map((f) => [f.id, f]));
  assert.deepEqual(Object.keys(by).sort(), ['bodyId', 'closeId', 'hookId', 'nastyId']);
  assert.deepEqual(r.body.files.map((f) => f.id).filter((id) => id !== 'nastyId'), ['hookId', 'bodyId', 'closeId'], 'a reel\'s order: hook, body, CTA');
  assert.deepEqual(by.hookId.proposed, {script: 2, variant: {hook: 1}, stem: 'G2_H1'});
  assert.deepEqual([by.hookId.mimeType, by.hookId.size, by.hookId.modifiedTime], ['video/mp4', FILES.hookId.bytes.length, T]);
  assert.equal(by.hookId.fits, null);
  assert.equal(by.closeId.fits, null);
  assert.ok(!/[/\u001b\u202e]/.test(by.nastyId.name), by.nastyId.name);
  assert.equal((await call('GET', '/api/drive/list?folder=nope')).status, 404);
  const auth = await call('GET', '/api/drive/list?folder=denied');
  assert.deepEqual([auth.status, auth.body.code], [502, 'drive_auth']);
});

test('import: the mapping is checked against the identity before anything runs', async () => {
  project('p-map', {identity: {client: 'vibem', family: 'vibem-G2', script: 2, variant: {hook: 1, cta: 1}}});
  const n0 = drv.media.length;
  for (const files of [[{fileId: 'hookId', script: 2, variant: {hook: 2}}], [{fileId: 'hookId', script: 3}], [{fileId: 'hookId'}], [{fileId: '../x', script: 2}], [{fileId: 'hookId', script: 2}, {fileId: 'hookId', script: 2}], [{fileId: 'hookId', script: 2, hook: 2}], []]) {
    const r = await call('POST', '/api/drive/import', {project_id: 'p-map', files});
    assert.equal(r.status, 400, JSON.stringify(files));
    assert.equal(r.body.code, 'bad_mapping');
  }
  assert.equal((await call('POST', '/api/drive/import', {project_id: 'p-none', files: [{fileId: 'hookId', script: 2}]})).status, 404);
  assert.equal(drv.media.length, n0, 'nothing downloaded');
});

test('import: download → ingest → the project\'s timeline with srcKey and take; a second import is a no-op', {skip: !hasFfmpeg}, async () => {
  project('p-g2', {identity: {client: 'vibem', family: 'vibem-G2', script: 2, variant: {hook: 1, cta: 1}}});
  const n0 = drv.media.length;
  drv.cut.add('hookId'); // cut halfway: the job resumes it itself
  const s = await importJob({project_id: 'p-g2', files: [{fileId: 'hookId', script: 2, variant: {hook: 1}}, {fileId: 'bodyId', script: 2, variant: null}, {fileId: 'nastyId', script: 2, variant: {hook: 1}}]});
  assert.equal(s.status, 'done', JSON.stringify(s));
  assert.equal(s.progress, 100);
  assert.equal(s.added.length, 3);
  const p = readP('p-g2');
  assert.equal(p.clips.length, 3);
  const hook = p.clips.find((c) => c.label === 'g02-hook');
  assert.equal(hook.srcKey, `drive:hookId:${T}:${FILES.hookId.bytes.length}`);
  assert.deepEqual(hook.take, {script: 2, variant: {hook: 1}});
  assert.ok(fs.existsSync(path.join(pub, hook.src)) && fs.existsSync(path.join(pub, 'clips', 'thumbs', `${path.basename(hook.src, '.mp4')}.jpg`)));
  const nasty = p.clips.find((c) => c.srcKey.startsWith('drive:nastyId:'));
  assert.match(nasty.src, /^clips\/[\w-]+\.mp4$/, 'the clip file is named by the ingest, never by Drive');
  assert.ok(!/[/\u001b\u202e]/.test(nasty.label));
  assert.ok(!fs.existsSync(path.join(dir, 'etc')) && !fs.existsSync(path.join(uploads, 'etc')), 'nothing written where the name points');
  assert.deepEqual(fs.readdirSync(uploads).filter((f) => f.endsWith('.part')), [], 'the parts go once ingested');
  assert.equal(drv.media.length - n0, 4, 'three downloads, one of them resumed');
  assert.ok(p.updatedAt > '2026-09-27T00:00:00.000Z');
  // the same files again: nothing downloaded, nothing written
  const before = fs.readFileSync(path.join(pub, 'projects', 'p-g2.json'), 'utf8');
  const n1 = drv.media.length;
  const again = await importJob({project_id: 'p-g2', files: [{fileId: 'hookId', script: 2, variant: {hook: 1}}, {fileId: 'bodyId', script: 2}]});
  assert.equal(again.status, 'done');
  assert.deepEqual([again.added.length, again.skipped.map((x) => x.why)], [0, ['already imported', 'already imported']]);
  assert.equal(drv.media.length, n1);
  assert.equal(fs.readFileSync(path.join(pub, 'projects', 'p-g2.json'), 'utf8'), before);
  // another project: the clip made before is reused — no second download
  project('p-g2-copy');
  const other = await importJob({project_id: 'p-g2-copy', files: [{fileId: 'hookId', script: 2, variant: {hook: 1}}]});
  assert.equal(other.status, 'done');
  assert.equal(other.added.length, 1);
  assert.equal(drv.media.length, n1);
  assert.equal(readP('p-g2-copy').clips[0].src, hook.src);
});

test('import: a missing file fails alone; low disk stops before any download', {skip: !hasFfmpeg}, async () => {
  project('p-part');
  const s = await importJob({project_id: 'p-part', files: [{fileId: 'goneId', script: 2}, {fileId: 'closeId', script: 2, variant: {cta: 1}}]});
  assert.equal(s.status, 'error');
  assert.equal(s.code, 'not_found');
  assert.deepEqual([s.failed.map((f) => f.fileId), s.added.map((a) => a.fileId)], [['goneId'], ['closeId']]);
  assert.match(s.error, /1 of 2 not imported.*\(1 added/);
  project('p-disk');
  free = 2 ** 20; // at the floor: no room
  const n0 = drv.media.length;
  const d = await importJob({project_id: 'p-disk', files: [{fileId: 'otherId', script: 3, variant: {v: 2}}]});
  free = Infinity;
  assert.equal(d.status, 'error');
  assert.equal(d.code, 'low_disk');
  assert.match(d.error, /not enough free disk for G3_V2\.mp4/);
  assert.equal(drv.media.length, n0);
});

test('reel drive list / import: the same routes, --json, the error contract', {skip: !hasFfmpeg}, async () => {
  const cli = async (...args) => {
    let stdout = '', stderr = '';
    const code = await main(args, {env: {REEL_URL: base, REEL_TOKEN: 'reel_test'}, stdout: {write: (s) => (stdout += s)}, stderr: {write: (s) => (stderr += s)}, cwd: dir, home: dir, pollMs: 20, uidOf: () => null});
    bodies.push(stdout, stderr);
    return {code, out: stdout ? JSON.parse(stdout) : null};
  };
  const l = await cli('drive', 'list', 'F2', '--json');
  assert.equal(l.code, 0);
  assert.deepEqual(l.out.files.map((f) => [f.id, f.proposed.stem]), [['otherId', 'G3_V2']]);
  project('p-cli', {identity: {client: 'vibem', family: 'vibem-G3', script: 3, variant: {v: 2}}});
  const i = await cli('drive', 'import', 'p-cli', '--file', 'otherId=G3_V2', '--json');
  assert.equal(i.code, 0, JSON.stringify(i.out));
  assert.deepEqual(i.out.added.map((a) => [a.fileId, a.take]), [['otherId', 'G3_V2']]);
  const bad = await cli('drive', 'import', 'p-cli', '--file', 'otherId=G3_H2', '--json');
  assert.deepEqual([bad.code, bad.out.code], [2, 'bad_mapping']);
  const usage = await cli('drive', 'import', 'p-cli', '--file', 'otherId=hook', '--json');
  assert.deepEqual([usage.code, usage.out.code], [2, 'bad_usage']);
  const missing = await cli('drive', 'list', 'nope', '--json');
  assert.deepEqual([missing.code, missing.out.code], [4, 'not_found']);
  const denied = await cli('drive', 'list', 'denied', '--json');
  assert.deepEqual([denied.code, denied.out.code], [3, 'drive_auth']);
});

test('MCP import_drive takes no key it does not know: a variant beside the numbers is an error, never a body take', async () => {
  const {Client} = await import('@modelcontextprotocol/sdk/client/index.js');
  const {StdioClientTransport} = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({name: 'test', version: '0'});
  await client.connect(new StdioClientTransport({command: 'node', args: ['mcp/server.mjs'], cwd: path.dirname(path.dirname(new URL(import.meta.url).pathname)), env: {...process.env, REEL_API: 'http://127.0.0.1:9', REEL_AGENT: 'drive-test'}}));
  try {
    const r = await client.callTool({name: 'import_drive', arguments: {project_id: 'no-such-drive-project', files: [{file_id: 'hookId', script: 2, variant: {hook: 1}}]}});
    const said = r.content.map((c) => c.text ?? '').join('\n');
    assert.ok(r.isError && /unrecognized key.*variant/i.test(said) && !/not found/.test(said), said);
  } finally { await client.close(); }
});

test('the key, its path and the token are in no answer, job state or log line', () => {
  assert.ok(bodies.length > 10);
  for (const s of [...bodies, ...logs]) for (const secret of [KEY_MARK, 'PRIVATE KEY', keyFile, 'ya29.fake', 'secrets']) assert.ok(!s.includes(secret), `"${secret}" leaked in ${s.slice(0, 200)}`);
});
