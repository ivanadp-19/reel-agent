// Clip ingest (POST /api/add-clip): probe → remux or transcode → thumbnail → a clip.
//   ?path=<file> (the MCP with the primary token; the reel CLI with a user token, only for files that user
//     could read anyway — server/tokens.mjs openForUser) — synchronous: answers with the clip JSON
//   ?upload=<id>&size=n (the reel CLI) — a part it uploaded in chunks (server/uploads.mjs), taken whole and
//     removed once ingested; synchronous too — the CLI and the MCP wait for the clip in the answer
//   ?upload=<id>&size=n&async=1 (the editor, editor/upload.ts) — the same part, as a job (below)
//   a body (the browser upload)           — asynchronous: once the upload is on disk it answers 202 {jobId} and
//     works in the background; GET /api/add-clip/<jobId> → {status: running|done|error, progress, label, clip | error}.
//     The job does not depend on the upload's connection: a browser that goes away after uploading still gets
//     its clip in public/clips/ — a proxy's timeout (Railway's edge answered 502 after ~2 min) no longer matters.
// Jobs live in memory, like the other job stores of the backend.
// A file with the same bytes as a source already in public/clips/ (that very file, one ingested before, or a copy
// of it) is not ingested again: the clip points at that source and keeps its transcripts (sameSource).
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {tokenOk} from './http.mjs';
import {openForUser as openForUserDefault} from './tokens.mjs';
import {UPLOAD_ID as UPLOAD_ID_DEFAULT, partFile as partFileDefault, partSize as partSizeDefault} from './uploads.mjs';

const json = (res, code, obj) => {
  res.writeHead(code, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(obj));
};

// run a command async, resolve {code, stdout, stderr}; onStdout sees every chunk (ffmpeg's -progress pipe:1)
const run = (cmd, args, {cwd, onStdout} = {}) =>
  new Promise((resolve) => {
    const c = spawn(cmd, args, {cwd});
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => { out += d; onStdout?.(String(d)); });
    c.stderr.on('data', (d) => (err = (err + d).slice(-8000)));
    c.on('close', (code) => resolve({code, stdout: out, stderr: err}));
    c.on('error', (e) => resolve({code: 1, stdout: out, stderr: err + String(e)}));
  });

// ffmpeg -progress lines → seconds of output written (out_time_us, or out_time_ms — microseconds too, despite the name)
export function progressSec(chunk) {
  let sec = null;
  for (const m of chunk.matchAll(/^out_time_(?:us|ms)=(\d+)$/gm)) sec = +m[1] / 1e6;
  return sec;
}

// an ingest failure: `error` for the user, `detail` the ffmpeg stderr tail (the sync answer keeps both)
class IngestError extends Error {
  constructor(message, detail = '') { super(message); this.detail = detail; }
}

// progress bands of one ingest: probe 0–5, remux/transcode 5–95, thumbnail 95–100
const pctIn = (from, to, frac) => Math.round(from + (to - from) * Math.max(0, Math.min(1, frac)));

// g: the gate's verdict on the request (server/http.mjs gate) — via, uid, user of a reel CLI token.
// freeBytes() / minFreeBytes: the disk the clip lands on and its floor (the backend's REEL_RENDER_MIN_FREE_DISK_MB):
// a clip that would leave less is refused 507 low_disk before anything is written. onClip(clip): after each
// ingest that made a clip (the backend queues its half-graded scan; must not throw)
export function createClipIngest({publicDir, root, token, uploadsDir = path.join(root, '.uploads'), openForUser = openForUserDefault,
  partFile = partFileDefault, partSize = partSizeDefault, UPLOAD_ID = UPLOAD_ID_DEFAULT,
  hdrLut = () => null, explain = (tail, fallback) => fallback, log = console.log, freeBytes = () => Infinity, minFreeBytes = 0, onClip = () => {}}) {
  const jobs = {}; // jobId -> {status, progress, label, clip?, error?}
  const byPart = new Map(); // an upload part's file -> the job made from it (a second tab, a retry whose 202 was lost)
  const reserved = new Set(); // clip ids of ingests in flight, so two uploads of one name never share an id
  const clipsDir = path.join(publicDir, 'clips');
  const thumbsDir = path.join(clipsDir, 'thumbs');

  const durationOf = async (file) => parseFloat((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], {cwd: root})).stdout) || 0;
  const sha256 = async (file) => { const h = crypto.createHash('sha256'); for await (const b of fs.createReadStream(file)) h.update(b); return h.digest('hex'); };
  // Adding Guion1.mp4 again made Guion1-2 — no transcript cache, so its audio went to Deepgram again. A file whose
  // bytes public/clips/ already has is that source: the file itself, one ingested before (clips/ holds its remux or
  // transcode, other bytes: the sha256 of what came in is recorded in clips/sha256/<hash> → the id), or a copy of a clip
  const hashes = path.join(clipsDir, 'sha256');
  const inflight = new Map(); // sha256 → the ingest making it: a second of the same bytes waits, then finds its clip
  const sizeOf = (id) => fs.statSync(path.join(clipsDir, `${id}.mp4`)).size;
  async function sameSource(real, hash) {
    try { const [id, size] = fs.readFileSync(path.join(hashes, hash), 'utf8').split(' '); if (sizeOf(id) === +size) return id; } catch {} // the clip it made, still there
    // ponytail: hashes the same-size clips on each ingest (rare: sizes seldom match); record the clips' own hashes if it gets slow
    const size = fs.statSync(real).size;
    for (const n of fs.readdirSync(clipsDir)) if (n.endsWith('.mp4') && fs.statSync(path.join(clipsDir, n)).size === size && (await sha256(path.join(clipsDir, n))) === hash) return n.slice(0, -4);
    return null;
  }
  const reused = async (same, {rawName, tag}) => {
    const dur = await durationOf(path.join(clipsDir, `${same}.mp4`));
    log(`ingest ${tag}: same bytes as clips/${same}.mp4 → reused, nothing re-encoded or re-transcribed`);
    return {id: same, src: `clips/${same}.mp4`, label: rawName.replace(/\.[^.]+$/, ''), inSec: 0, outSec: dur, sourceDurationSec: dur, ingest: `same file as clips/${same}.mp4: reused with its transcripts`};
  };

  // tmp → the clip: the source public/clips/ has for these bytes, or a new one (make); resolves the clip, throws an IngestError
  async function ingest(a) {
    a.report?.(0, 'Probing');
    const real = fs.realpathSync(a.tmp);
    if (path.dirname(real) === fs.realpathSync(clipsDir) && real.endsWith('.mp4')) return reused(path.basename(real, '.mp4'), a);
    const hash = await sha256(real);
    for (let w; (w = inflight.get(hash)); ) await w.catch(() => {});
    const p = (async () => {
      const same = await sameSource(real, hash);
      if (same) return reused(same, a);
      const clip = await make(a);
      fs.mkdirSync(hashes, {recursive: true});
      fs.writeFileSync(path.join(hashes, hash), `${clip.id} ${sizeOf(clip.id)}`);
      return clip;
    })();
    inflight.set(hash, p);
    try { return await p; } finally { inflight.delete(hash); }
  }

  // tmp → public/clips/<id>.mp4 + thumbnail
  async function make({tmp, id, tag, rawName, report = () => {}}) {
    const out = path.join(clipsDir, `${id}.mp4`);
    // probe codec / pixel format / size / rotation / duration
    const probe = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,pix_fmt,width,height,color_transfer:stream_side_data=rotation:format=duration', '-of', 'json', tmp], {cwd: root});
    let codec = '', pix = '', duration = 0, w = 0, h = 0, rotated = false, trc = '';
    try {
      const p = JSON.parse(probe.stdout);
      const s = p.streams?.[0] ?? {};
      codec = s.codec_name ?? ''; pix = s.pix_fmt ?? ''; w = s.width ?? 0; h = s.height ?? 0; trc = s.color_transfer ?? '';
      rotated = (s.side_data_list ?? []).some((d) => d.rotation && d.rotation % 180 !== 0);
      duration = parseFloat(p.format?.duration ?? '0') || 0;
    } catch {}

    // Already 1080p-class h264/yuv420 and not rotated → fast remux. Anything
    // else (4K phones, HEVC, rotation metadata, 10-bit) is re-encoded: rotation
    // baked in, fitted inside 1080×1920 (portrait) or 1920×1080 (landscape).
    // Remotion's compositor cannot read 2160-tall sources.
    const lut = hdrLut(trc);
    const hdr = !!lut;
    const compatible = codec === 'h264' && pix.startsWith('yuv420') && !rotated && w <= 1080 && h <= 1920 && !hdr;
    const verb = compatible ? 'Remuxing' : 'Transcoding';
    log(`ingest ${tag}: probed ${codec} ${pix} ${w}x${h}${rotated ? ' rotated' : ''}${hdr ? ` ${trc}` : ''} ${duration.toFixed(1)}s → ${verb.toLowerCase()}`);
    const fit = "scale=w='if(gt(iw,ih),1920,1080)':h='if(gt(iw,ih),1080,1920)':force_original_aspect_ratio=decrease:force_divisible_by=2";
    // HDR: fit first (cheaper), then BT.2020 YUV → RGB → LUT → BT.709 YUV
    const vf = hdr
      ? `${fit},scale=in_color_matrix=bt2020:in_range=tv:out_range=pc,format=gbrp16le,lut3d=file=${lut},scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv`
      : fit;
    report(5, verb);
    const onStdout = (d) => { const s = progressSec(d); if (s != null && duration > 0) report(pctIn(5, 95, s / duration), verb); };
    const t0 = Date.now();
    const enc = compatible
      ? await run('ffmpeg', ['-y', '-nostats', '-progress', 'pipe:1', '-i', tmp, '-c', 'copy', '-movflags', '+faststart', out], {cwd: root, onStdout})
      : await run('ffmpeg', ['-y', '-nostats', '-progress', 'pipe:1', '-i', tmp, '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
          ...(hdr ? ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'] : []),
          '-c:a', 'aac', '-ar', '48000', '-movflags', '+faststart', out], {cwd: root, onStdout});
    if (enc.code !== 0) {
      fs.rmSync(out, {force: true});
      throw new IngestError('transcode failed', enc.stderr.slice(-300));
    }
    log(`ingest ${tag}: ${verb === 'Remuxing' ? 'remux' : 'transcode'} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // re-probe duration from the output (authoritative)
    const dur = (await durationOf(out)) || duration || 0;

    report(95, 'Making thumbnail');
    await run('ffmpeg', ['-y', '-ss', String(Math.min(0.5, dur / 2)), '-i', out, '-frames:v', '1',
      '-vf', 'scale=160:-1', path.join(thumbsDir, `${id}.jpg`)], {cwd: root});

    return {
      id, src: `clips/${id}.mp4`, label: rawName.replace(/\.[^.]+$/, ''),
      inSec: 0, outSec: dur, sourceDurationSec: dur,
      ...(hdr ? {ingest: `${trc === 'smpte2084' ? 'PQ' : 'HLG'} HDR tone-mapped to SDR`} : {}),
    };
  }

  // the job's one line a user can act on: the message plus what ffmpeg said
  const message = (e) => {
    const why = e instanceof IngestError && e.detail ? explain(e.detail, '') : '';
    return (why ? `${e.message}: ${why}` : e.message || String(e)).slice(0, 300);
  };

  // an ingest as a job: 202 {jobId} at once, then GET /api/add-clip/<jobId> (a browser body, the editor's upload part)
  function startJob(res, {tmp, id, rawName, cleanup, what}) {
    const jobId = crypto.randomUUID();
    const tag = `${jobId.slice(0, 8)} ${id}`;
    jobs[jobId] = {status: 'running', progress: 0, label: 'Starting'};
    json(res, 202, {jobId});
    log(`ingest ${tag}: start (${what})`);
    const report = (progress, label) => { jobs[jobId] = {status: 'running', progress, label}; };
    ingest({tmp, id, rawName, tag, report})
      .then((clip) => { jobs[jobId] = {status: 'done', progress: 100, label: 'Ready', clip}; log(`ingest ${tag}: done ${clip.src} (${clip.sourceDurationSec.toFixed(1)}s)`); onClip(clip); })
      .catch((e) => { jobs[jobId] = {status: 'error', error: message(e)}; log(`ingest ${tag}: error — ${message(e)}`); })
      .finally(cleanup);
    return jobId;
  }

  // POST /api/add-clip and GET /api/add-clip/<jobId>; true when the request was one of them
  function handle(req, res, url, g = {}) {
    if (req.method === 'GET' && url.pathname.startsWith('/api/add-clip/')) {
      json(res, 200, jobs[url.pathname.split('/').pop()] ?? {status: 'unknown'});
      return true;
    }
    if (!(req.method === 'POST' && url.pathname === '/api/add-clip')) return false;
    const rawName = url.searchParams.get('name') || 'clip.mp4';
    const base = rawName.replace(/\.[^.]+$/, '').replace(/[^\w\-]/g, '_').slice(0, 40) || 'clip';
    fs.mkdirSync(thumbsDir, {recursive: true});
    const refuse = (code, obj) => { json(res, code, obj); return true; };

    // a local file path (same machine, from the MCP server) skips the upload —
    // only with the run token, and only video files. A user token (the reel CLI) may
    // name a path too, but only one of its own files or one anyone can read
    // (server/tokens.mjs openForUser): the backend never reads other users' files for it.
    // ?upload=<id>: a part the CLI uploaded in chunks (server/uploads.mjs), taken whole.
    const local = url.searchParams.get('path');
    const upload = url.searchParams.get('upload');
    let opened = null, uploaded = null;
    if (local) {
      if (!/\.(mp4|mov|m4v|webm|mkv|avi|mts)$/i.test(local)) return refuse(400, {error: 'path must be a video file', code: 'bad_path'});
      if (g.via === 'user-token') {
        opened = openForUser(local, g.uid);
        if (!opened) return refuse(403, {error: 'the backend may not read this file for you: it is not yours and not readable by everyone', code: 'path_not_allowed', hint: 'upload it instead (reel clips add does when this happens)'});
      } else {
        if (!tokenOk([token], req.headers['x-reel-token'])) return refuse(403, {error: 'path ingest needs the backend token'}); // the primary only: the MCP this backend runs, never a client's
        if (!fs.existsSync(local)) return refuse(400, {error: 'path must be an existing video file'});
      }
    } else if (upload) {
      if (!UPLOAD_ID.test(upload)) return refuse(400, {error: 'bad upload id', code: 'bad_request'});
      uploaded = partFile(uploadsDir, g.user, upload);
      // the part already has a job (it may be gone by now): that job — never a second clip, nor its part taken from under it
      const had = url.searchParams.get('async') === '1' && byPart.get(uploaded);
      const done = had && jobs[had].status === 'done' && fs.existsSync(path.join(publicDir, jobs[had].clip.src));
      if (had && (jobs[had].status === 'running' || done)) {
        if (done) fs.rmSync(uploaded, {force: true}); // the same file uploaded again after it
        return refuse(202, {jobId: had});
      }
      const have = partSize(uploaded), want = +(url.searchParams.get('size') ?? have);
      if (!have) return refuse(404, {error: `no upload ${upload}`, code: 'not_found'});
      if (have !== want) return refuse(409, {error: `upload ${upload} has ${have} of ${want} bytes`, code: 'upload_incomplete', size: have});
    }
    // the space it takes: the clip made from the source (≈ its size), plus the upload itself for a browser body
    const need = local || uploaded ? fs.statSync(opened?.path ?? local ?? uploaded).size : 2 * (+req.headers['content-length'] || 0);
    const free = freeBytes();
    if (free - need < minFreeBytes) {
      opened?.close(); req.resume(); // the body is not taken
      const mb = (n) => Math.round(n / 2 ** 20);
      return refuse(507, {error: `not enough free disk for this clip: ${mb(free)} MB free, it needs ${mb(need)} MB over the ${mb(minFreeBytes)} MB floor`, code: 'low_disk', hint: 'free space (old exports: scripts/cleanup-exports.mjs --apply) or ask an admin'});
    }

    // unique id (avoid clobbering existing clips and ingests still running)
    let id = base;
    let n = 2;
    while (reserved.has(id) || fs.existsSync(path.join(clipsDir, `${id}.mp4`))) id = `${base}-${n++}`;
    reserved.add(id);
    // the source: the checked descriptor, the MCP's path, the uploaded part, or the browser's body written here.
    // Removed afterwards unless it is a path of the caller's (a finished upload part goes too)
    const tmp = opened?.path ?? local ?? uploaded ?? path.join(root, `.upload-${id}.bin`);
    const cleanup = () => { reserved.delete(id); opened?.close(); if (!local) { try { fs.rmSync(tmp, {force: true}); } catch {} } };

    if (uploaded && url.searchParams.get('async') === '1') {
      byPart.set(tmp, startJob(res, {tmp, id, rawName, cleanup, what: `upload ${upload}, ${(fs.statSync(tmp).size / 1048576).toFixed(1)} MB`}));
      return true;
    }
    if (local || uploaded) {
      const tag = id;
      log(`ingest ${tag}: start (${local ? `path ${local}` : `upload ${upload}`})`);
      ingest({tmp, id, rawName, tag})
        .then((clip) => { log(`ingest ${tag}: done ${clip.src} (${clip.sourceDurationSec.toFixed(1)}s)`); json(res, 200, clip); onClip(clip); })
        .catch((e) => { log(`ingest ${tag}: error — ${message(e)}`); json(res, 500, {error: e.message.slice(0, 200), ...(e.detail ? {detail: e.detail} : {})}); })
        .finally(cleanup);
      return true;
    }

    const ws = fs.createWriteStream(tmp);
    req.pipe(ws);
    let failed = false;
    const abort = (why) => { if (failed) return; failed = true; ws.destroy(); cleanup(); log(`ingest ${id}: upload ${why}`); if (!res.headersSent) json(res, 500, {error: 'upload failed'}); };
    req.on('error', () => abort('failed'));
    req.on('close', () => { if (!req.complete) abort('interrupted'); });
    ws.on('error', () => abort('could not be written'));
    ws.on('finish', () => { if (!failed) startJob(res, {tmp, id, rawName, cleanup, what: `${(ws.bytesWritten / 1048576).toFixed(1)} MB uploaded`}); });
    return true;
  }

  return {handle, jobs};
}
