// The public review pages (/r/<token>): a static HTML page that plays the latest
// final of a project on a phone, links to the earlier finals and offers the full
// render as a download. No bundle, no script: the version picker is plain links.
//   GET /r/<token>[?v=n]          the page
//   GET /r/<token>/v/<n>.mp4      the 720p proxy (byte ranges)
//   GET /r/<token>/v/<n>.jpg      its poster
//   GET /r/<token>/v/<n>/full.mp4 the full render, as a download
// Only files a version of the token's project references are ever served; the
// token is the only credential (see scripts/reviews.mjs for how it is kept).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {playableVersions, resolveToken} from '../scripts/reviews.mjs';
import {serveFile} from './http.mjs';

export const PRIVACY_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer', // the token must not leave in a Referer
  'Cache-Control': 'private, no-cache', // revalidated with the ETag: a revoked link stops at the next request
  'X-Content-Type-Options': 'nosniff',
};
const PAGE_CSP = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
const mb = (b) => `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB`;
const day = (iso) => new Date(iso).toLocaleDateString('es', {day: 'numeric', month: 'short', year: 'numeric'});
const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'reel';

function text(res, status, body, head = false) {
  res.writeHead(status, {...PRIVACY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8'});
  res.end(head ? undefined : body);
}

// a file a version references, only inside its own folder of public/
function inside(publicDir, rel, folder) {
  if (typeof rel !== 'string' || !rel) return null;
  const abs = path.resolve(publicDir, rel);
  const root = path.join(publicDir, folder) + path.sep;
  return abs.startsWith(root) && fs.existsSync(abs) && fs.statSync(abs).isFile() ? abs : null;
}

export function reviewPage({token, name, versions, current, fullOf}) {
  const cur = versions.find((x) => x.v === current) ?? versions[0];
  const base = `/r/${token}/v/${cur.v}`;
  const full = fullOf(cur);
  const others = versions.map((x) => x.v === cur.v
    ? `<li aria-current="true"><b>v${x.v}</b> · ${esc(day(x.createdAt))} · ${esc(clock(x.durationSec))}${x === versions[0] ? ' · última' : ''}</li>`
    : `<li><a href="/r/${token}?v=${x.v}">v${x.v}</a> · ${esc(day(x.createdAt))} · ${esc(clock(x.durationSec))}${x === versions[0] ? ' · última' : ''}</li>`).join('');
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<title>${esc(name)} · v${cur.v}</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0b0b0c;color:#e8e8ea;font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:480px;margin:0 auto;padding:12px 16px calc(24px + env(safe-area-inset-bottom))}
h1{font-size:16px;font-weight:600;margin:4px 0 10px;overflow-wrap:anywhere}
.meta{color:#9a9aa2;font-size:13px;margin:8px 0 14px}
video{display:block;width:100%;max-height:78vh;aspect-ratio:9/16;background:#000;border-radius:10px;object-fit:contain}
a{color:#8ab4ff}
.dl{display:inline-block;margin:0 0 18px;padding:10px 14px;border:1px solid #33333a;border-radius:8px;text-decoration:none;color:#e8e8ea}
h2{font-size:13px;font-weight:600;color:#9a9aa2;text-transform:uppercase;letter-spacing:.04em;margin:8px 0 6px}
ul{list-style:none;margin:0;padding:0}
li{padding:8px 0;border-top:1px solid #1f1f24;font-size:14px}
</style>
</head>
<body>
<main>
<h1>${esc(name)} — versión ${cur.v}</h1>
<video src="${base}.mp4" playsinline controls preload="metadata"${cur.poster ? ` poster="${base}.jpg"` : ''}></video>
<p class="meta">${esc(day(cur.createdAt))} · ${esc(clock(cur.durationSec))}</p>
${full ? `<a class="dl" href="${base}/full.mp4" download>Descargar original (1080p, ${esc(mb(full.size))})</a>` : ''}
${versions.length > 1 ? `<h2>Versiones</h2><ul>${others}</ul>` : ''}
</main>
</body>
</html>
`;
}

// → true when it answered (every /r/ request is answered here)
export function handleReview(req, res, url, {publicDir, now = Date.now()}) {
  const head = req.method === 'HEAD';
  if (req.method !== 'GET' && !head) { res.writeHead(405, {...PRIVACY_HEADERS, Allow: 'GET, HEAD'}); res.end(); return true; }
  const m = url.pathname.match(/^\/r\/([A-Za-z0-9_-]+)(?:\/v\/(\d{1,5})(\.mp4|\.jpg|\/full\.mp4))?\/?$/);
  if (!m) { text(res, 404, 'Not found', head); return true; }
  const dir = path.join(publicDir, 'reviews');
  const t = resolveToken(dir, m[1], {now});
  if (t.state === 'unknown') { text(res, 404, 'Not found', head); return true; }
  if (t.state !== 'live') { text(res, 410, t.state === 'revoked' ? 'Este link fue revocado.' : 'Este link expiró.', head); return true; }
  const versions = playableVersions(t.reviews, publicDir);
  if (!versions.length) { text(res, 404, 'No hay versiones disponibles.', head); return true; }
  const fullOf = (x) => { const f = inside(publicDir, x.file, 'exports'); return f && /\.mp4$/.test(f) ? {file: f, size: fs.statSync(f).size} : null; };

  if (!m[2]) {
    let name = 'Reel';
    try { name = JSON.parse(fs.readFileSync(path.join(publicDir, 'projects', `${t.projectId}.json`), 'utf8')).name || name; } catch {}
    const html = reviewPage({token: m[1], name, versions, current: +url.searchParams.get('v') || versions[0].v, fullOf});
    const etag = `"${crypto.createHash('sha1').update(html).digest('base64url')}"`;
    const headers = {...PRIVACY_HEADERS, 'Content-Security-Policy': PAGE_CSP, ETag: etag};
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return true; }
    res.writeHead(200, {...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html)});
    res.end(head ? undefined : html);
    return true;
  }
  const x = versions.find((y) => y.v === +m[2]);
  if (!x) { text(res, 404, 'Not found', head); return true; }
  if (m[3] === '.mp4') {
    const f = inside(publicDir, x.proxy, 'reviews');
    if (!f) { text(res, 404, 'Not found', head); return true; }
    serveFile(req, res, f, PRIVACY_HEADERS);
    return true;
  }
  if (m[3] === '.jpg') {
    const f = inside(publicDir, x.poster, 'reviews');
    if (!f) { text(res, 404, 'Not found', head); return true; }
    serveFile(req, res, f, PRIVACY_HEADERS);
    return true;
  }
  const full = fullOf(x);
  if (!full) { text(res, 404, 'Not found', head); return true; }
  let name = 'reel';
  try { name = JSON.parse(fs.readFileSync(path.join(publicDir, 'projects', `${t.projectId}.json`), 'utf8')).name || name; } catch {}
  serveFile(req, res, full.file, {...PRIVACY_HEADERS, 'Content-Disposition': `attachment; filename="${slug(name)}-v${x.v}.mp4"`});
  return true;
}
