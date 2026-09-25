// Clip ingest (POST /api/add-clip): probe → remux or transcode → thumbnail → a clip.
//   ?path=<file> (the MCP with the primary token; the reel CLI with a user token, only for files that user
//     could read anyway — server/tokens.mjs openForUser) — synchronous: answers with the clip JSON
//   ?upload=<id>&size=n (the reel CLI) — a part it uploaded in chunks (server/uploads.mjs), taken whole and
//     removed once ingested; synchronous too — the CLI and the MCP wait for the clip in the answer
//   a body (the browser upload)           — asynchronous: once the upload is on disk it answers 202 {jobId} and
//     works in the background; GET /api/add-clip/<jobId> → {status: running|done|error, progress, label, clip | error}.
//     The job does not depend on the upload's connection: a browser that goes away after uploading still gets
//     its clip in public/clips/ — a proxy's timeout (Railway's edge answered 502 after ~2 min) no longer matters.
// Jobs live in memory, like the other job stores of the backend.
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

// g: the gate's verdict on the request (server/http.mjs gate) — via, uid, user of a reel CLI token
export function createClipIngest({publicDir, root, token, uploadsDir = path.join(root, '.uploads'), openForUser = openForUserDefault,
  partFile = partFileDefault, partSize = partSizeDefault, UPLOAD_ID = UPLOAD_ID_DEFAULT,
  hdrLut = () => null, explain = (tail, fallback) => fallback, log = console.log}) {
  const jobs = {}; // jobId -> {status, progress, label, clip?, error?}
  const reserved = new Set(); // clip ids of ingests in flight, so two uploads of one name never share an id
  const clipsDir = path.join(publicDir, 'clips');
  const thumbsDir = path.join(clipsDir, 'thumbs');

  // tmp → public/clips/<id>.mp4 + thumbnail; resolves the clip, throws an IngestError
  async function ingest({tmp, id, rawName, tag, report = () => {}}) {
    const out = path.join(clipsDir, `${id}.mp4`);
    report(0, 'Probing');
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
    const dp = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of',
      'default=noprint_wrappers=1:nokey=1', out], {cwd: root});
    const dur = parseFloat(dp.stdout) || duration || 0;

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
      const have = partSize(uploaded), want = +(url.searchParams.get('size') ?? have);
      if (!have) return refuse(404, {error: `no upload ${upload}`, code: 'not_found'});
      if (have !== want) return refuse(409, {error: `upload ${upload} has ${have} of ${want} bytes`, code: 'upload_incomplete', size: have});
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

    if (local || uploaded) {
      const tag = id;
      log(`ingest ${tag}: start (${local ? `path ${local}` : `upload ${upload}`})`);
      ingest({tmp, id, rawName, tag})
        .then((clip) => { log(`ingest ${tag}: done ${clip.src} (${clip.sourceDurationSec.toFixed(1)}s)`); json(res, 200, clip); })
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
    ws.on('finish', () => {
      if (failed) return;
      const jobId = crypto.randomUUID();
      const tag = `${jobId.slice(0, 8)} ${id}`;
      jobs[jobId] = {status: 'running', progress: 0, label: 'Starting'};
      json(res, 202, {jobId});
      log(`ingest ${tag}: start (${(ws.bytesWritten / 1048576).toFixed(1)} MB uploaded)`);
      const report = (progress, label) => { jobs[jobId] = {status: 'running', progress, label}; };
      ingest({tmp, id, rawName, tag, report})
        .then((clip) => { jobs[jobId] = {status: 'done', progress: 100, label: 'Ready', clip}; log(`ingest ${tag}: done ${clip.src} (${clip.sourceDurationSec.toFixed(1)}s)`); })
        .catch((e) => { jobs[jobId] = {status: 'error', error: message(e)}; log(`ingest ${tag}: error — ${message(e)}`); })
        .finally(cleanup);
    });
    return true;
  }

  return {handle, jobs};
}
