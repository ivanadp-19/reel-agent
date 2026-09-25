// Remote (Pexels) B-roll → files in public/broll/ before a render: headless Chrome
// fetching big files mid-render failed half-way, so every remote src is downloaded
// once and the props are rewritten to the local copy. Runs inside the render job's
// queue slot (scripts/render-runner.mjs prepare), so it must never hang the queue:
//   - every download has a deadline (REEL_BROLL_DOWNLOAD_SEC, default 600 s) that
//     covers the body too, and follows the job's signal (cancel, stall control);
//   - progress is reported per MB, which keeps the job's stall control fed;
//   - ffprobe / the 4K downscale are killed on abort and report their pid.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';

export const DOWNLOAD_MS = +(process.env.REEL_BROLL_DOWNLOAD_SEC || 600) * 1000;

// The only remote host we ever download from. Anything else in a B-roll src
// (an agent talked into it by a transcript, a stray URL) is refused, and
// redirects are re-checked hop by hop so a 302 cannot point at the LAN.
export const ALLOWED_REMOTE = /(^|\.)pexels\.com$/i;
export async function fetchAllowed(url, {signal, fetchImpl = fetch, allow = ALLOWED_REMOTE} = {}, hops = 0) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !allow.test(u.hostname)) throw new Error(`refusing to download from ${u.hostname}: only Pexels URLs are fetched`);
  const r = await fetchImpl(u, {redirect: 'manual', signal});
  if ([301, 302, 303, 307, 308].includes(r.status)) {
    if (hops >= 3) throw new Error('too many redirects');
    return fetchAllowed(new URL(r.headers.get('location') ?? '', u).href, {signal, fetchImpl, allow}, hops + 1);
  }
  return r;
}

// a command, killed when the signal aborts; resolves {code, stdout, stderr}
export function runCmd(cmd, args, {signal, onPid, cwd} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const c = spawn(cmd, args, {cwd});
    onPid?.(c.pid);
    let out = '', err = '';
    const kill = () => { try { c.kill('SIGKILL'); } catch {} };
    signal?.addEventListener('abort', kill, {once: true});
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    const done = (code) => {
      signal?.removeEventListener('abort', kill);
      onPid?.(null);
      if (signal?.aborted) reject(signal.reason); else resolve({code, stdout: out, stderr: err});
    };
    c.on('close', done);
    c.on('error', () => done(1));
  });
}

// the body into a file, chunk by chunk; stops at once when the signal aborts
// (a Response body does not always follow the fetch signal, so the read races it)
async function saveBody(r, file, {signal, onBytes}) {
  const reader = r.body.getReader();
  const fd = fs.openSync(file, 'w');
  let bytes = 0;
  const aborted = new Promise((_, rej) => {
    if (signal?.aborted) rej(signal.reason);
    signal?.addEventListener('abort', () => rej(signal.reason), {once: true});
  });
  aborted.catch(() => {});
  try {
    for (;;) {
      const {done, value} = await Promise.race([reader.read(), aborted]);
      if (done) break;
      fs.writeSync(fd, value);
      bytes += value.length;
      onBytes?.(bytes);
    }
  } catch (e) {
    reader.cancel().catch(() => {});
    throw e;
  } finally {
    fs.closeSync(fd);
  }
  return bytes;
}

// download remote B-roll srcs into dir and rewrite props.brolls[].src in place (to `broll/<name>`)
//   signal     the job's: cancel / stall → everything stops, no .part left behind
//   progress   (frac 0–1, label) per downloaded MB and per file
export async function localizeRemoteBrolls(props, {dir, signal, timeoutMs = DOWNLOAD_MS, fetchImpl = fetch, allow = ALLOWED_REMOTE, run = runCmd, onPid, progress} = {}) {
  const items = (Array.isArray(props?.brolls) ? props.brolls : []).filter((b) => /^https?:\/\//.test(b.src ?? ''));
  if (!items.length) return props;
  fs.mkdirSync(dir, {recursive: true});
  let n = 0;
  for (const b of items) {
    n++;
    const ext = b.kind === 'video' ? 'mp4' : (b.src.match(/\.(jpe?g|png|webp)(\?|$)/i)?.[1] ?? 'jpg');
    // named by a hash of the whole URL: Pexels files of one size share their last
    // characters ("…_1080_1920_30fps.mp4"), and a name from those made two cues share one file
    const name = `px-${crypto.createHash('sha1').update(b.src).digest('hex').slice(0, 16)}.${ext}`;
    const file = path.join(dir, name);
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
      const label = `Downloading B-roll ${n}/${items.length}`;
      progress?.((n - 1) / items.length, label);
      const deadline = AbortSignal.timeout(timeoutMs);
      const sig = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const tmp = file + '.part';
      try {
        const r = await fetchAllowed(b.src, {signal: sig, fetchImpl, allow});
        if (!r.ok) throw new Error(`B-roll download ${r.status}: ${b.src}`);
        let lastMb = 0;
        await saveBody(r, tmp, {signal: sig, onBytes: (bytes) => {
          const mb = Math.floor(bytes / 1e6);
          if (mb > lastMb) { lastMb = mb; progress?.((n - 1) / items.length, `${label} · ${mb} MB`); }
        }});
        if (ext === 'mp4') {
          // Remotion's compositor fails on 4K sources ("Could not extract frame ...
          // Request closed"); the output is 1080x1920 anyway, so cap the height.
          const probe = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'csv=p=0', tmp], {signal, onPid});
          const h = parseInt(probe.stdout, 10) || 0;
          if (h > 1920) {
            progress?.((n - 0.5) / items.length, `Downscaling B-roll ${n}/${items.length}`);
            const small = file + '.small.mp4';
            try {
              const enc = await run('ffmpeg', ['-y', '-i', tmp, '-vf', 'scale=-2:1920', '-c:v', 'libx264', '-preset', 'veryfast',
                '-crf', '20', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', small], {signal, onPid});
              if (enc.code !== 0) throw new Error(`B-roll downscale failed: ${enc.stderr.slice(-200)}`);
            } catch (e) { fs.rmSync(small, {force: true}); throw e; }
            fs.rmSync(tmp, {force: true});
            fs.renameSync(small, file);
          } else fs.renameSync(tmp, file);
        } else fs.renameSync(tmp, file);
      } catch (e) {
        fs.rmSync(tmp, {force: true});
        if (deadline.aborted && !signal?.aborted) throw new Error(`B-roll download timed out after ${Math.round(timeoutMs / 1000)} s: ${b.src}`);
        throw e;
      }
    }
    b.src = `broll/${name}`;
  }
  progress?.(1, 'B-roll ready');
  return props;
}
