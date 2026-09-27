// Import from Google Drive (T20b, CEO-9): a client's originals arrive in a Drive folder shared (Viewer) with a
// service account. No googleapis dependency: an RS256 JWT signed here with node:crypto is exchanged at Google's
// token endpoint for a drive.readonly access token — kept in memory until it expires, never written anywhere —
// then files.list / files.get (alt=media, with Range) over fetch.
//   GET  /api/drive/list?folder=<id | folder URL>[&project=<id>] → {folder, files: [{id, name, size, modifiedTime,
//        mimeType, proposed: {script, variant, stem} | null, fits?}], others}: the videos in it, each with the take
//        its NAME suggests (proposeTake) — a proposal the user confirms (R2-27); with project, whether it is a take
//        of that project's identity (takeFits)
//   POST /api/drive/import {project_id, files: [{fileId, script, variant}]} → 202 {jobId}: the mapping stated
//        explicitly (the editor's dialog, the MCP's import_drive, `reel drive import`); 400 bad_mapping before
//        anything runs — a take of another script or variant than the project's identity, or a row with another key
//   GET  /api/drive/import/<jobId> → {status: running | done | error, progress, label, added, skipped, failed, error?, code?}
// Each file: files.get (its size and modifiedTime) → downloaded as an upload part (server/uploads.mjs partFile, a
// namespace no token user can have) resuming with Range from what the part holds (a backend killed mid-download
// resumes on the next import), after a free-disk check → a clip through the same ingest as POST
// /api/add-clip?upload= (server/ingest.mjs ingestPart) → added to the project in its row (scripts/stages.mjs),
// with srcKey `drive:<fileId>:<modifiedTime>:<size>` and the take the user confirmed. That key makes a second
// import a no-op: a clip of it already on the timeline is skipped, and one ingested before for any project is
// reused without downloading (its record in <uploads>/drive/).
// Errors: 401/403 → DriveAuth (no retry), 404 → NotFound, 429 (or a 403 rateLimitExceeded) → backoff honoring
// Retry-After, at most `retries` (3) times → RateLimit; a full disk → LowDisk (the part removed); a part whose md5 is
// not the file's md5Checksum (replaced on Drive mid-download) → Changed, that file fails (the part removed).
// The key: REEL_DRIVE_SA_KEY, a path outside public/ that group and others cannot read, read when a token is minted
// and never logged, returned, or reachable through a tool (they take a folder id and file ids only). File names
// from Drive are untrusted: sanitized for display and labels, never part of a path.
// REEL_DRIVE_API / REEL_DRIVE_TOKEN_URL point at a fake Drive in tests only; production leaves them unset.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {identityStem, validateIdentity} from '../src/validate.ts';
import {addedClip} from '../src/timeline.ts';
import {inRow, readProject, saveProject} from '../scripts/stages.mjs';
import {partFile as partFileDefault, partSize} from './uploads.mjs';

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const VIDEO = /\.(mp4|mov|m4v|webm|mkv|avi|mts)$/i;
const DRIVE_ID = /^[\w-]{1,200}$/;
const mb = (n) => Math.round(n / 2 ** 20);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const md5Of = async (file) => { const h = crypto.createHash('md5'); for await (const c of fs.createReadStream(file)) h.update(c); return h.digest('hex'); };

// name: DriveAuth | NotFound | RateLimit | LowDisk | DriveNet | DriveError | Changed | NotVideo | IngestFailed | BadRequest;
// code: what the API answers (and the reel CLI's exit family); status: the HTTP status of the answer
export class DriveError extends Error {
  constructor(name, code, message, status = 502) { super(message); this.name = name; this.code = code; this.status = status; }
}
const authError = (m) => new DriveError('DriveAuth', 'drive_auth', m, 502);

// A Drive file name, as shown and as a clip label: no control or bidi-override characters, no path separators,
// no leading dots, ≤ 120 characters. Never used as a path (parts are named by a hash).
export const safeName = (n) => String(n ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069/\\]/g, '_').replace(/^[.\s]+/, '').trim().slice(0, 120) || 'drive-file';
const mimeOf = (m) => (/^[\w.+-]{1,60}\/[\w.+-]{1,100}$/.test(String(m)) ? m : '');
const isVideo = (f) => String(f.mimeType ?? '').startsWith('video/') || VIDEO.test(String(f.name ?? ''));
// a folder id, or the id in a folder URL (…/drive/folders/<id>?usp=sharing)
export const folderId = (s) => String(s ?? '').trim().match(/\/folders\/([\w-]+)/)?.[1] ?? String(s ?? '').trim();

// The take a file NAME suggests — a proposal the user confirms, never applied on its own (R2-27):
// the script (G2, g02, Guion3, Guión 10) and the variant: hook (H1, hook, gancho — 1 when unnumbered), CTA (C1,
// CTA1, close, cierre) or a plain version (V2, Guion3_2 = G3 V2). No marker: the body every variant shares (null).
// → {script: n | null, variant, stem: 'G2_H1' | null}
export function proposeTake(name) {
  const s = safeName(name).replace(/\.[^.]*$/, '');
  const num = (re) => { const m = s.match(re); return m ? +(m[1] || m[2] || 1) : null; };
  const script = num(/(?:^|[^a-z])(?:gui[oó]n|g)[\s_-]?0*(\d{1,2})(?!\d)/i);
  const hook = num(/(?:^|[^a-z])(?:h[\s_-]?0*(\d{1,3})|(?:hook|gancho)[\s_-]?0*(\d{0,3}))(?![a-z\d.])/i);
  const cta = num(/(?:^|[^a-z])(?:c[\s_-]?0*(\d{1,3})|(?:cta|close|cierre)[\s_-]?0*(\d{0,3}))(?![a-z\d.])/i);
  const v = hook || cta ? null : num(/(?:^|[^a-z])(?:v[\s_-]?0*(\d{1,3})|gui[oó]n[\s_-]?\d{1,2}[_-]0*(\d{1,3}))(?![a-z\d.])/i);
  const variant = v ? {v} : hook || cta ? {...(hook ? {hook} : {}), ...(cta ? {cta} : {})} : null;
  return {script, variant, stem: script ? takeStem({script, variant}) : null};
}
const takeStem = ({script, variant}) => identityStem({client: '', family: '', script, variant});

// hook, body (or a version), CTA, per script: the order a reel plays them, so a whole folder imports in it
const order = ({script, variant}) => (script ?? 100) * 3 + (variant?.hook ? 0 : variant?.cta ? 2 : 1);

// one mapping row → {script, variant} normalized, or why not (the identity's own rules for a script and a variant)
export function takeOf(x) {
  const r = validateIdentity({client: 'x', script: x?.script, variant: x?.variant ?? null});
  return r.error ? {error: r.error.replace(/^identity\./, '')} : {take: {script: r.identity.script, variant: r.identity.variant}};
}
// a take into a project: null when it belongs there (no identity: anything; else its script, and a variant part —
// hook, cta, v — only of the project's own variant; the body, variant null, is every variant's), else why not
export function takeFits(take, identity) {
  const id = validateIdentity(identity).identity;
  if (!id) return null;
  if (take.script !== id.script) return `${takeStem(take)} is not a take of ${identityStem(id)} (another script)`;
  for (const [k, n] of Object.entries(take.variant ?? {})) if (id.variant?.[k] !== n) return `${takeStem(take)} is another variant's take, not ${identityStem(id)}'s`;
  return null;
}

// ---- auth: the service account's key → a signed JWT → an access token ----
// The key file: outside public/ (it would be served as media there), not readable or writable by group / others.
// Every message says what to fix and never the path or anything in the file.
export function readKey(file, publicDir) {
  if (!file) throw authError('Drive import is not set up on this backend: REEL_DRIVE_SA_KEY names no service-account key');
  let real, st;
  try { real = fs.realpathSync(file); st = fs.statSync(real); } catch { throw authError('the service-account key that REEL_DRIVE_SA_KEY names cannot be read'); }
  if (publicDir) {
    let pub = path.resolve(publicDir);
    try { pub = fs.realpathSync(pub); } catch {}
    if (real.startsWith(pub + path.sep)) throw authError('the service-account key must live outside public/ (files there are served): move it and point REEL_DRIVE_SA_KEY at the new place');
  }
  if (st.mode & 0o077) throw authError('the service-account key is readable by other users: chmod 600 it');
  let k;
  try { k = JSON.parse(fs.readFileSync(real, 'utf8')); } catch { throw authError('the service-account key is not a JSON key file'); }
  if (typeof k?.client_email !== 'string' || typeof k?.private_key !== 'string') throw authError('the service-account key has no client_email / private_key: it must be a service account\'s JSON key');
  // parsed here, so a truncated, hand-edited (literal \n), encrypted or non-RSA key is DriveAuth — never a
  // network failure at signing time, nor an ECDSA signature under an RS256 header
  let pk;
  try { pk = crypto.createPrivateKey(k.private_key); } catch { throw authError('the service-account key\'s private_key is not a usable private key: download a fresh JSON key and do not edit it'); }
  if (pk.asymmetricKeyType !== 'rsa') throw authError('the service-account key\'s private_key is not an RSA key: Google signs service accounts with RS256');
  return {client_email: k.client_email, private_key: pk};
}
const b64u = (x) => Buffer.from(x).toString('base64url');
// RS256 (RSASSA-PKCS1-v1_5 + SHA-256) over header.claims, as Google's OAuth 2.0 for service accounts asks
export function signJwt({client_email, private_key}, {aud = TOKEN_URL, scope = SCOPE, now = Date.now()} = {}) {
  const iat = Math.floor(now / 1000);
  const signed = `${b64u(JSON.stringify({alg: 'RS256', typ: 'JWT'}))}.${b64u(JSON.stringify({iss: client_email, scope, aud, iat, exp: iat + 3600}))}`;
  return `${signed}.${crypto.sign('sha256', Buffer.from(signed), private_key).toString('base64url')}`;
}

// Retry-After: seconds or an HTTP date; else 1, 2, 4 s — at most maxWaitMs (a hostile header never parks the job)
const waitMs = (h, attempt, maxWaitMs) => {
  const s = h == null || h === '' ? NaN : Number(h);
  const ms = Number.isFinite(s) ? s * 1000 : Date.parse(h) - Date.now();
  return Math.min(maxWaitMs, Number.isFinite(ms) && ms >= 0 ? ms : 1000 * 2 ** attempt);
};

export function createDrive({keyFile, publicDir, api = DRIVE_API, tokenUrl = TOKEN_URL, fetch = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, retries = 3, maxWaitMs = 60e3} = {}) {
  let cached = null; // {token, exp}: in memory only

  // one request with the rate-limit backoff → the Response (2xx), else a DriveError
  async function send(url, init = {}, {what, auth = true} = {}) {
    for (let attempt = 0; ; attempt++) {
      const headers = auth ? {...init.headers, authorization: `Bearer ${await token()}`} : init.headers; // outside the try: a key problem is not the network's
      let r;
      try { r = await fetch(url, {...init, headers}); }
      catch (e) { throw new DriveError('DriveNet', 'drive_unreachable', `cannot reach Google Drive (${e.cause?.code ?? e.message})`); }
      if (r.ok || r.status === 416) return r; // 416: a Range past the end — the caller starts over
      const b = await r.json().catch(() => ({}));
      const reason = String(b?.error?.errors?.[0]?.reason ?? b?.error?.status ?? (typeof b?.error === 'string' ? b.error : '')).slice(0, 60);
      const limited = r.status === 429 || (r.status === 403 && /ratelimit/i.test(reason));
      if (limited && attempt < retries) { await sleep(waitMs(r.headers.get('retry-after'), attempt, maxWaitMs)); continue; }
      if (limited) throw new DriveError('RateLimit', 'rate_limited', `Google Drive is rate-limiting this service account (${what}), ${retries + 1} tries — import again in a few minutes`, 429);
      if (!auth && r.status < 500) throw authError(`Google refused the service account's key (${r.status}${reason ? ` ${reason}` : ''}): check that the key is current and not revoked`);
      if (!auth) throw new DriveError('DriveError', 'drive_error', `Google's token endpoint answered ${r.status}: try again later`);
      if (r.status === 401 || r.status === 403) {
        cached = null;
        throw authError(`Google Drive refused the service account (${r.status}${reason ? ` ${reason}` : ''}) for ${what}: share the folder with the service account as Viewer, and check its key`);
      }
      if (r.status === 404) throw new DriveError('NotFound', 'not_found', `${what}: not found in Drive — check the id, and that the folder is shared with the service account`, 404);
      throw new DriveError('DriveError', 'drive_error', `Google Drive answered ${r.status}${reason ? ` ${reason}` : ''} (${what})`);
    }
  }
  async function token() {
    if (cached && now() < cached.exp) return cached.token;
    const assertion = signJwt(readKey(keyFile, publicDir), {aud: tokenUrl, now: now()});
    const r = await send(tokenUrl, {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion}).toString()}, {what: 'the token', auth: false});
    const b = await r.json().catch(() => ({}));
    if (typeof b.access_token !== 'string') throw authError('Google\'s token endpoint answered without an access token');
    cached = {token: b.access_token, exp: now() + Math.max(0, (+b.expires_in || 3600) - 60) * 1000};
    return cached.token;
  }

  // the files of a folder (not trashed), every page
  async function list(folder) {
    const id = folderId(folder);
    if (!DRIVE_ID.test(id)) throw new DriveError('BadRequest', 'bad_request', 'folder: a Drive folder id or its URL (…/drive/folders/<id>)', 400);
    const files = [];
    let pageToken = '';
    do {
      const q = new URLSearchParams({q: `'${id}' in parents and trashed=false`, fields: 'nextPageToken,files(id,name,size,modifiedTime,mimeType)', pageSize: '1000', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', ...(pageToken ? {pageToken} : {})});
      const b = await (await send(`${api}/files?${q}`, {}, {what: `folder ${id}`})).json();
      files.push(...(Array.isArray(b.files) ? b.files : []));
      pageToken = typeof b.nextPageToken === 'string' ? b.nextPageToken : '';
    } while (pageToken && files.length < 20000);
    return {folder: id, files};
  }
  const get = async (fileId) => (await send(`${api}/files/${fileId}?fields=id,name,size,modifiedTime,mimeType,md5Checksum&supportsAllDrives=true`, {}, {what: `file ${fileId}`})).json();

  // f ({id, name, size, md5Checksum}) → dest, resumed from what dest holds (Range); a connection cut mid-file is
  // resumed up to `retries` times, then fails with the part kept for the next import. ENOSPC: the part removed,
  // LowDisk. The whole part must hash to Drive's md5Checksum: a file replaced on Drive between a cut and its resume
  // leaves the old head + the new tail (alt=media serves the current revision) — removed, Changed. (Drive gives an
  // md5Checksum for every binary file; one without is not checked.)
  // write(file, flags): the part's stream (tests put a full disk there)
  async function download(f, dest, {onBytes = () => {}, write = (file, flags) => fs.createWriteStream(file, {flags})} = {}) {
    const size = +f.size;
    for (let attempt = 0; ; attempt++) {
      let have = partSize(dest);
      if (have > size) { fs.rmSync(dest, {force: true}); have = 0; }
      if (have === size) break;
      const r = await send(`${api}/files/${f.id}?alt=media&supportsAllDrives=true`, {headers: have ? {range: `bytes=${have}-`} : {}}, {what: f.name});
      if (r.status === 416) { await r.body?.cancel().catch(() => {}); fs.rmSync(dest, {force: true}); if (attempt >= retries) throw new DriveError('DriveError', 'drive_error', `Google Drive would not resume ${f.name}`); continue; }
      let got = r.status === 206 ? have : 0; // a 200 to a Range: the whole file again
      fs.mkdirSync(path.dirname(dest), {recursive: true});
      const count = new Transform({transform(c, _e, cb) { got += c.length; onBytes(got, size); cb(null, c); }});
      try {
        await pipeline(Readable.fromWeb(r.body), count, write(dest, got ? 'a' : 'w'));
        if (partSize(dest) === size) break;
      } catch (e) {
        if (e.code === 'ENOSPC') { fs.rmSync(dest, {force: true}); throw new DriveError('LowDisk', 'low_disk', `disk full while downloading ${f.name}: its partial file was removed — free space and import again`, 507); }
      }
      if (attempt >= retries) throw new DriveError('DriveNet', 'drive_unreachable', `the download of ${f.name} broke off at ${mb(partSize(dest))} of ${mb(size)} MB — import again: it goes on from there`);
      await sleep(Math.min(maxWaitMs, 1000 * 2 ** attempt));
    }
    if (f.md5Checksum && (await md5Of(dest)) !== f.md5Checksum) {
      fs.rmSync(dest, {force: true});
      throw new DriveError('Changed', 'drive_changed', `${f.name} changed on Drive during the download (its bytes are not the file's): import again`, 409);
    }
  }
  return {list, get, download, token};
}

// ---- the import job and the routes ----
const readBody = (req, max = 256e3) => new Promise((resolve, reject) => {
  let d = '';
  req.on('data', (c) => { d += c; if (d.length > max) { reject(new DriveError('BadRequest', 'bad_request', 'request too large', 413)); req.destroy(); } });
  req.on('end', () => resolve(d));
  req.on('error', reject);
});
const json = (res, code, obj) => { res.writeHead(code, {'Content-Type': 'application/json'}); res.end(JSON.stringify(obj)); };
const PER_FILE = new Set(['not_found', 'not_video', 'ingest_failed', 'drive_changed']); // the next file may still work; anything else stops the job

// drive: createDrive(); ingestPart(part, name, report) → clip (server/ingest.mjs); freeBytes / minFreeBytes: the
// disk the parts and clips land on and its floor (the backend's REEL_RENDER_MIN_FREE_DISK_MB); logStage(project, stage,
// ms, extra): the import's time in the project's timing log (scripts/timing.mjs)
export function createDriveImport({drive, publicDir, uploadsDir, ingestPart, freeBytes = () => Infinity, minFreeBytes = 0, log = console.log, logStage = () => {}, writePart, partFile = partFileDefault}) {
  const jobs = {};
  const running = new Map(); // project id → its import job: one at a time per project
  const inflight = new Map(); // a Drive file's key → the download + ingest making its clip (two projects importing it at once)
  const records = path.join(uploadsDir, 'drive'); // key → the clip it made, so another import does not download it again

  // one file: its clip (reused, or downloaded + ingested), then onto the project's timeline
  async function importOne(job, it, i, n) {
    const meta = await drive.get(it.fileId);
    const name = safeName(meta.name), size = +meta.size;
    if (!isVideo(meta) || !Number.isSafeInteger(size) || size <= 0) throw new DriveError('NotVideo', 'not_video', `${name} is not a video file (${mimeOf(meta.mimeType) || 'no type'})`, 400);
    const key = `drive:${it.fileId}:${meta.modifiedTime}:${size}`;
    const row = {fileId: it.fileId, name, take: takeStem(it.take)};
    if ((readProject(publicDir, job.projectId)?.clips ?? []).some((c) => c.srcKey === key)) return job.skipped.push({...row, why: 'already imported'});
    const set = (frac, label) => Object.assign(job, {progress: Math.min(99, Math.round((100 * (i + frac)) / n)), label: `${label} (${i + 1}/${n})`});
    const rec = path.join(records, `${sha(key).slice(0, 32)}.json`);
    const recorded = () => { try { const c = JSON.parse(fs.readFileSync(rec, 'utf8')); return fs.existsSync(path.join(publicDir, c.src)) ? c : null; } catch { return null; } };
    while (inflight.has(key)) await inflight.get(key).catch(() => {});
    let clip = recorded();
    if (!clip) {
      const p = (async () => {
        const part = partFile(uploadsDir, '.drive', sha(key).slice(0, 32));
        const need = size - partSize(part) + size, free = freeBytes(); // what is left to download, and the clip made from it
        if (free - need < minFreeBytes) throw new DriveError('LowDisk', 'low_disk', `not enough free disk for ${name}: ${mb(free)} MB free, it needs ${mb(need)} MB over the ${mb(minFreeBytes)} MB floor`, 507);
        const from = partSize(part);
        log(`drive import ${job.tag}: ${name} (${it.fileId}) ${mb(size)} MB${from ? `, resuming at ${mb(from)} MB` : ''}`);
        await drive.download({...meta, id: it.fileId, name}, part, {write: writePart, onBytes: (got) => set((0.8 * got) / size, `Downloading ${name} · ${mb(got)} of ${mb(size)} MB`)});
        set(0.8, `Ingesting ${name}`);
        let c;
        try { c = await ingestPart(part, name, (pct, label) => set(0.8 + (0.2 * pct) / 100, `${label} ${name}`)); }
        catch (e) { throw e.code === 'low_disk' ? new DriveError('LowDisk', 'low_disk', e.message, 507) : new DriveError('IngestFailed', 'ingest_failed', `${name}: ${e.message}`, 500); }
        fs.mkdirSync(records, {recursive: true});
        fs.writeFileSync(rec, JSON.stringify(c));
        return c;
      })();
      inflight.set(key, p);
      try { clip = await p; } finally { inflight.delete(key); }
    }
    const {ingest: note, ...raw} = clip;
    const r = await inRow(job.projectId, () => {
      const prev = readProject(publicDir, job.projectId);
      if (!prev) throw new DriveError('NotFound', 'not_found', `project ${job.projectId} is gone`, 404);
      const now = prev.clips ?? [];
      if (now.some((c) => c.srcKey === key)) return {why: 'already imported'};
      const c = addedClip(now, {...raw, label: name.replace(/\.[^.]*$/, ''), srcKey: key, take: it.take});
      if (!c) return {why: `same file as ${raw.src}, already on the timeline as ${now.find((x) => x.src === raw.src).id}`};
      const [status, out] = saveProject(publicDir, job.projectId, {clips: [...now, c], updatedAt: prev.updatedAt}, {actor: job.actor});
      if (status !== 200) throw new DriveError('DriveError', 'save_failed', `${name}: the project was not saved (${out.error})`, status);
      return {clip: c.id};
    });
    if (r.why) job.skipped.push({...row, clip: raw.id, why: r.why});
    else job.added.push({...row, clip: r.clip, ...(note ? {ingest: note} : {})});
  }

  async function run(job, items) {
    let stop = null;
    const t0 = Date.now();
    for (const [i, it] of items.entries()) {
      try { await importOne(job, it, i, items.length); }
      catch (e) {
        const err = e instanceof DriveError ? e : new DriveError('DriveError', 'drive_error', String(e?.message ?? e).slice(0, 300));
        log(`drive import ${job.tag}: ${it.fileId} — ${err.name}: ${err.message}`);
        if (!PER_FILE.has(err.code)) { stop = err; break; }
        job.failed.push({fileId: it.fileId, error: err.message, code: err.code});
      }
    }
    const done = `${job.added.length} added, ${job.skipped.length} already there`;
    if (!stop && !job.failed.length) Object.assign(job, {status: 'done', progress: 100, label: done});
    else Object.assign(job, {status: 'error', error: `${stop ? stop.message : `${job.failed.length} of ${items.length} not imported: ${job.failed.map((f) => f.error).join('; ')}`} (${done})`, code: stop?.code ?? job.failed[0].code});
    log(`drive import ${job.tag}: ${job.status} — ${done}${job.failed.length ? `, ${job.failed.length} failed` : ''}${stop ? `, stopped: ${stop.name}` : ''}`);
    logStage(job.projectId, 'drive-import', Date.now() - t0, {files: items.length, added: job.added.length, ...(job.status === 'done' ? {} : {ok: false})});
  }

  // true when the request was one of the routes
  async function handle(req, res, url, g = {}) {
    if (!url.pathname.startsWith('/api/drive/')) return false;
    const answer = (code, obj) => { json(res, code, obj); return true; };
    try {
      if (req.method === 'GET' && url.pathname === '/api/drive/list') {
        const project = url.searchParams.get('project');
        const identity = project && /^[\w-]+$/.test(project) ? readProject(publicDir, project)?.identity : null;
        const {folder, files} = await drive.list(url.searchParams.get('folder'));
        const videos = files.filter((f) => isVideo(f) && DRIVE_ID.test(String(f.id))).map((f) => {
          const proposed = proposeTake(f.name);
          return {id: f.id, name: safeName(f.name), size: +f.size || 0, modifiedTime: f.modifiedTime ?? null, mimeType: mimeOf(f.mimeType), proposed,
            ...(identity ? {fits: proposed.script ? takeFits(proposed, identity) : 'no script in the name'} : {})};
        }).sort((a, b) => order(a.proposed) - order(b.proposed) || a.name.localeCompare(b.name)); // a reel's order: hook, body, CTA — the order they are imported in
        return answer(200, {folder, files: videos, others: files.length - videos.length});
      }
      const jm = url.pathname.match(/^\/api\/drive\/import\/([\w-]{1,64})$/);
      if (req.method === 'GET' && jm) {
        const {tag, actor, ...pub} = jobs[jm[1]] ?? {status: 'unknown'};
        return answer(200, pub);
      }
      if (!(req.method === 'POST' && url.pathname === '/api/drive/import')) return answer(404, {error: 'no such drive route', code: 'not_found'});
      let b;
      try { b = JSON.parse((await readBody(req)) || '{}'); } catch (e) { if (e instanceof DriveError) throw e; return answer(400, {error: 'bad json', code: 'bad_request'}); }
      const projectId = b?.project_id;
      if (typeof projectId !== 'string' || !/^[\w-]+$/.test(projectId)) return answer(400, {error: 'project_id required', code: 'bad_request'});
      const p = readProject(publicDir, projectId);
      if (!p) return answer(404, {error: `project ${projectId} not found`, code: 'not_found'});
      const files = b.files;
      if (!Array.isArray(files) || !files.length || files.length > 100) return answer(400, {error: 'files: 1–100 of {fileId, script, variant}', code: 'bad_mapping'});
      const issues = [], items = [], seen = new Set();
      files.forEach((f, i) => {
        const at = `files[${i}]`;
        if (typeof f?.fileId !== 'string' || !DRIVE_ID.test(f.fileId)) return issues.push(`${at}.fileId: a Drive file id`);
        const odd = Object.keys(f).filter((k) => !['fileId', 'script', 'variant'].includes(k)); // a hook beside variant is refused, never dropped into a body take
        if (odd.length) return issues.push(`${at}: unknown ${odd.join(', ')} — a row is {fileId, script, variant}`);
        if (seen.has(f.fileId)) return issues.push(`${at}: ${f.fileId} is listed twice`);
        seen.add(f.fileId);
        const t = takeOf(f);
        if (t.error) return issues.push(`${at}.${t.error}`);
        const why = takeFits(t.take, p.identity);
        if (why) return issues.push(`${at} (${f.fileId}): ${why}`);
        items.push({fileId: f.fileId, take: t.take});
      });
      if (issues.length) return answer(400, {error: `the mapping does not fit: ${issues.join('; ')}`, code: 'bad_mapping', issues});
      if (running.has(projectId)) return answer(409, {error: `an import into ${projectId} is running: wait for it`, code: 'conflict', running: running.get(projectId)});
      const jobId = crypto.randomUUID();
      const job = jobs[jobId] = {status: 'running', progress: 0, label: 'Starting', projectId, added: [], skipped: [], failed: [], tag: `${jobId.slice(0, 8)} ${projectId}`, actor: g.user ?? g.via ?? null};
      running.set(projectId, jobId);
      log(`drive import ${job.tag}: start (${items.length} file${items.length === 1 ? '' : 's'})`);
      run(job, items).catch((e) => Object.assign(job, {status: 'error', error: String(e?.message ?? e).slice(0, 300), code: 'error'})).finally(() => running.delete(projectId));
      return answer(202, {jobId});
    } catch (e) {
      if (!(e instanceof DriveError)) console.error(`${req.method} ${url.pathname}:`, e);
      return answer(e instanceof DriveError ? e.status : 500, {error: String(e?.message ?? e).slice(0, 300), code: e?.code ?? 'error'});
    }
  }
  return {handle, jobs};
}
