// Resumable uploads for `reel clips add` when the backend may not read the file by
// path: the CLI appends it in chunks (PUT /api/uploads/<id>?offset=n), asks where the
// part stands after an error (GET /api/uploads/<id> → {size}) and goes on from there,
// then ingests it (POST /api/add-clip?upload=<id>&size=n). Parts live in
// <dir>/<owner>-<id>.part — one namespace per token user — and are swept after a day.
import fs from 'node:fs';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';

export const UPLOAD_ID = /^[0-9a-f]{16,64}$/;
export const CHUNK_MAX = 64 * 2 ** 20;
export const partFile = (dir, owner, id) => path.join(dir, `${String(owner || 'local').replace(/[^\w.-]/g, '_')}-${id}.part`);
export const partSize = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };

export function sweepParts(dir, {maxAgeMs = 86400e3, now = Date.now()} = {}) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    const f = path.join(dir, n);
    try { if (n.endsWith('.part') && now - fs.statSync(f).mtimeMs > maxAgeMs) fs.rmSync(f, {force: true}); } catch {}
  }
}

// Append one chunk where the part ends. A chunk sent at another offset (a retry of one
// that already landed, a second writer) gets 409 and the size to resume from; whatever
// bytes of a broken chunk arrived stay — they are the next bytes of the file.
const writing = new Set();
export async function appendChunk(req, file, offset, {maxBytes, freeBytes = Infinity, minFreeBytes = 0} = {}) {
  const refuse = (status, out) => { req.resume(); return [status, out]; }; // drain the chunk we do not take
  const len = +req.headers['content-length'];
  if (!Number.isInteger(len) || len <= 0) return refuse(411, {error: 'a chunk needs Content-Length', code: 'bad_chunk'});
  if (len > CHUNK_MAX) return refuse(413, {error: `chunks of at most ${CHUNK_MAX / 2 ** 20} MB`, code: 'chunk_too_large'});
  if (writing.has(file)) return refuse(409, {error: 'another chunk of this upload is being written', code: 'offset_mismatch', size: partSize(file)});
  const size = partSize(file);
  if (offset !== size) return refuse(409, {error: `the upload is at ${size} bytes, not ${offset}`, code: 'offset_mismatch', size});
  if (size + len > maxBytes) return refuse(413, {error: `uploads of at most ${Math.round(maxBytes / 2 ** 20)} MB`, code: 'too_large'});
  if (freeBytes - len < minFreeBytes) return refuse(507, {error: 'not enough free disk for this upload', code: 'low_disk'});
  writing.add(file);
  try {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    await pipeline(req, fs.createWriteStream(file, {flags: 'a'}));
  } catch {
    // the client went away mid-chunk: it asks for the size and resumes
  } finally {
    writing.delete(file);
  }
  return [200, {size: partSize(file)}];
}
