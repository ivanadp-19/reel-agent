// The public review pages (/r/<token>): a static HTML page that plays the latest
// final of a project on a phone, links to the earlier finals and offers the full
// render as a download. No bundle, no script: the version picker is plain links.
//   GET /r/<token>[?v=n]          the page
//   GET /r/<token>/v/<n>.mp4      the 720p proxy (byte ranges)
//   GET /r/<token>/v/<n>.jpg      its poster
//   GET /r/<token>/v/<n>/full.mp4 the full render, as a download
// Only files a version of the token's project references are ever served; the
// token is the credential (see scripts/reviews.mjs for how it is kept). A client's project
// (identity.client) needs a login of that client as well (CEO-4, E-1: seesClient in
// server/http.mjs): without a session the page goes to /login, with another client's it is 403.
// A project without a client is served exactly as before (R-1). /r/ stays read-only (GET / HEAD, form-action 'none'):
// approving, revoking and notes live in the bandeja below, behind the login, never behind a token.
//
// The bandeja (/bandeja, handleBandeja — docs/designs/cesar-etapas-bandeja.md §6-§7, Sección 11): the client's reviewer
// and the owner, by login session only (server/http.mjs gate → kind 'bandeja'). Plain server-rendered HTML that works at
// 375 px and on a desktop; one small inline script (hashed in the CSP) keeps a note's draft in localStorage (UX-1).
//   GET  /bandeja                    every client project the session may see (seesClient), grouped by script (G) ×
//                                    variant: the delivered version (the newest approved) next to the newest one, each with
//                                    its proxy, its QC técnico label (versionQc), its review state and the variant's notes;
//                                    the owner also gets the inbox (ownerInbox: notes to confirm, guion-conflict, judge down,
//                                    3 reds in a row, low disk, notes on v1 per variant)
//   POST /bandeja/aprobar            {project, v, confirm}   the reviewer retypes the variant name; only from QC superado
//   POST /bandeja/revocar            {project, v, reason}
//   POST /bandeja/nota               {project, v, atSec, text} anchored on the version's snapshot (anchorAt)
//   POST /bandeja/nota/estado        {project, v, note, step: confirmar | descartar (owner) | verificar (reviewer), reason?}
//   POST /bandeja/salir              sign out (the session cookie cleared, like POST /logout)
// Every POST (E-8: one function each): a login session (humanOnly, E-2 — tokens, basic auth and loopback get 403), an
// Origin of this site, the session's CSRF token, ≤ 30 per user per minute, then the step of scripts/review-states.mjs
// inside the reviews row (withVersion), which checks the state it writes over; 303 back to the variant. The notes are
// plain text, escaped, never linked, on every surface.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {loadReviews, playableVersions, resolveToken, withVersion} from '../scripts/reviews.mjs';
import {actorOf, addNote, anchorAt, approve, moveNote, noteClock, openNotes, ownerInbox, revoke, variantName, variantState, versionLabel, versionQc} from '../scripts/review-states.mjs';
import {validateIdentity} from '../src/validate.ts';
import {humanOnly, projectClients, seesClient, serveFile} from './http.mjs';
import {SESSION_COOKIE, clientIp, cookieHeader, parseCookies, readBody, sameSite} from './session.mjs';

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
${cur.datosPorConfirmar?.length ? `<h2>Datos por confirmar</h2><ul>${cur.datosPorConfirmar.map((d) => `<li>«${esc(d.dato)}» en ${esc(clock(d.atSec))} — no se oye en el audio de este reel</li>`).join('')}</ul>` : ''}
${versions.length > 1 ? `<h2>Versiones</h2><ul>${others}</ul>` : ''}
</main>
</body>
</html>
`;
}

// What a new link of the project needs besides itself — the one sentence every Share surface passes on
// (POST /api/reviews/<id>/links → share_version, the editor's Share panel, reel review-link): a client's
// project opens only with a login of that client, and local mode has no login. → {clients, access: string | null}
export function linkAccess(publicDir, projectId, {login}) {
  const clients = projectClients(publicDir, projectId);
  const who = clients.join(', ');
  const access = !clients.length ? null : login ? `This link opens only with a login of client ${who} (a reviewer in REEL_USER_ROLES) or an owner's.`
    : `This link cannot be opened here: a client's link needs a login of client ${who}, and this backend has no login (local mode; REEL_PUBLIC=1 turns it on).`;
  return {clients, access};
}

// `g` = the gate's answer ({kind: 'review', user, via, role, clients, primary}); `login` = public mode,
// where /login exists. → true when it answered (every /r/ request is answered here)
export function handleReview(req, res, url, {publicDir, now = Date.now(), g = null, login = false}) {
  const head = req.method === 'HEAD';
  if (req.method !== 'GET' && !head) { res.writeHead(405, {...PRIVACY_HEADERS, Allow: 'GET, HEAD'}); res.end(); return true; }
  const m = url.pathname.match(/^\/r\/([A-Za-z0-9_-]+)(?:\/v\/(\d{1,5})(\.mp4|\.jpg|\/full\.mp4))?\/?$/);
  if (!m) { text(res, 404, 'Not found', head); return true; }
  const dir = path.join(publicDir, 'reviews');
  const t = resolveToken(dir, m[1], {now});
  if (t.state === 'unknown') { text(res, 404, 'Not found', head); return true; }
  if (!seesClient(g, projectClients(publicDir, t.projectId))) {
    if (login && !g?.user && !m[2]) { res.writeHead(303, {...PRIVACY_HEADERS, Location: `/login?next=${encodeURIComponent(url.pathname + url.search)}`}); res.end(); return true; }
    text(res, 403, 'Este reel es de un cliente: entra con una cuenta de ese cliente.', head);
    return true;
  }
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

// ---- the bandeja ----
// Every client project the caller may see (`sees(clients)`, seesClient), as the bandeja groups them: one variant per
// project with an identity (the live one, else its newest version's); its versions = the review versions rendered
// under an identity. → rows {projectId, name, identity, stem, versions, playable (v set), project (the live JSON)}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
export function bandejaRows(publicDir, sees) {
  const dir = path.join(publicDir, 'reviews'), pdir = path.join(publicDir, 'projects');
  const ids = (d) => { try { return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch { return []; } };
  const rows = [];
  for (const projectId of new Set([...ids(dir), ...ids(pdir)])) {
    if (!/^[\w-]+$/.test(projectId)) continue;
    const project = readJson(path.join(pdir, `${projectId}.json`));
    const r = loadReviews(dir, projectId);
    const versions = r.versions.filter((x) => x.identity);
    const identity = validateIdentity(project?.identity).identity ?? validateIdentity(versions.at(-1)?.identity).identity;
    if (!identity || !sees(projectClients(publicDir, projectId))) continue;
    rows.push({projectId, name: project?.name ?? projectId, identity, stem: variantName(identity), versions, playable: new Set(playableVersions(r, publicDir).map((x) => x.v)), project});
  }
  return rows.sort((a, b) => a.identity.client.localeCompare(b.identity.client) || a.identity.script - b.identity.script || a.stem.localeCompare(b.stem));
}

// the owner's inbox in the log (CEO-19: no push yet — a badge on the page and a line in the log): each item once per
// process, when it first shows (a note posted, a judge settled, the owner's page, the backend's start)
// ponytail: in memory — a restart logs what is still pending once more
const logged = new Set();
export function logInbox(items, log = console.error) {
  for (const i of items) if (!logged.has(i.key)) { logged.add(i.key); log(`[owner-inbox] ${i.kind}: ${i.text}`); }
}
// the inbox over every client project (whoever asks: the backend itself), new items logged → the items
export function refreshInbox({publicDir, disk = null, log = console.error}) {
  const items = ownerInbox(bandejaRows(publicDir, () => true), {disk});
  logInbox(items, log);
  return items;
}

// UX-1: a note's draft survives a reload — localStorage keyed by (projectId, v, atSec), every access in try/catch (a
// private window, blocked storage), cleared on send: once the send is answered with the page's ?ok=nota (a send that
// failed keeps it). "Segundo actual" / opening the form takes the video's second.
const BANDEJA_JS = `(() => {
  let s = null;
  try { s = window.localStorage; } catch (e) {}
  const get = (k) => { try { return s ? s.getItem(k) : null; } catch (e) { return null; } };
  const put = (k, v) => { try { if (s) s.setItem(k, v); } catch (e) {} };
  const del = (k) => { try { if (s) s.removeItem(k); } catch (e) {} };
  const keys = (p) => { const out = []; try { for (let i = 0; s && i < s.length; i++) { const k = s.key(i); if (k && k.startsWith(p)) out.push(k); } } catch (e) {} return out; };
  const sent = get('nota-enviada');
  if (sent) { del('nota-enviada'); if (/[?&]ok=nota(&|$)/.test(location.search)) del(sent); }
  for (const box of document.querySelectorAll('details[data-draft]')) {
    const form = box.querySelector('form'), at = form.elements.atSec, text = form.elements.text;
    const video = document.getElementById(box.dataset.video), prefix = box.dataset.draft;
    let key = null;
    const save = () => { const k = prefix + at.value; if (key && key !== k) del(key); key = k; if (text.value.trim()) put(k, text.value); else del(k); };
    const now = () => { if (video) { video.pause(); at.value = (Math.round(video.currentTime * 10) / 10).toFixed(1); } save(); };
    if (text.value) save();
    else { const k = keys(prefix).pop(), t = k ? get(k) : null; if (t) { key = k; at.value = k.slice(prefix.length); text.value = t; box.open = true; } }
    const b = box.querySelector('[data-now]');
    if (b) b.addEventListener('click', now);
    box.addEventListener('toggle', () => { if (box.open && !text.value.trim()) now(); });
    text.addEventListener('input', save);
    at.addEventListener('change', save);
    form.addEventListener('submit', () => { save(); put('nota-enviada', key); });
  }
})();`;
export const BANDEJA_CSP = `default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; script-src 'sha256-${crypto.createHash('sha256').update(BANDEJA_JS).digest('base64')}'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const cls = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]+/gi, '-').toLowerCase();
const hidden = (o) => Object.entries(o).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
const FLASH = {aprobada: 'Aprobada.', revocada: 'Aprobación revocada: la versión vuelve a por revisar.', nota: 'Nota guardada.', confirmada: 'Nota confirmada.', descartada: 'Nota descartada.', verificada: 'Nota verificada.'};
const KIND = {nota: 'Nota por confirmar', guion: 'Guion vs audio', juez: 'Juez caído', rojos: '3 rojos seguidos', disco: 'Disco bajo'};

function versionCard(r, x, {delivered, newest, reviewer, csrf, draft}) {
  const qc = versionQc(x), label = versionLabel(x, delivered), open = openNotes(x).length;
  const vid = `vid-${r.projectId}-${x.v}`, base = {csrf, project: r.projectId, v: x.v};
  const tag = x.v === delivered ? 'entregada' : x === newest ? 'la más nueva' : '';
  const video = r.playable.has(x.v)
    ? `<video id="${esc(vid)}" src="/${esc(x.proxy)}"${x.poster ? ` poster="/${esc(x.poster)}"` : ''} controls playsinline preload="metadata"></video>`
    : '<p class="gone">El video de esta versión ya no está (retención).</p>';
  const findings = qc.state === 'hallazgos' && qc.findings.length
    ? `<details class="findings"><summary>Ver hallazgos</summary><ul>${qc.findings.slice(0, 8).map((f) => `<li>${f.at != null ? `<b>${esc(noteClock(f.at))}</b> ` : ''}${esc(f.msg)}</li>`).join('')}</ul></details>` : '';
  let actions = '';
  if (reviewer) {
    if (x.approval) actions += `<details><summary>Revocar la aprobación</summary><form method="post" action="/bandeja/revocar">${hidden(base)}<label>Razón (la ve el equipo)<textarea name="reason" maxlength="500" rows="2" required></textarea></label><button>Revocar v${x.v}</button></form></details>`;
    else if (!qc.approvable) actions += `<p class="off"><button type="button" disabled>Aprobar v${x.v}</button> <span>${esc(qc.label)}: aprobar se habilita con QC técnico superado.</span></p>`;
    else actions += `<details class="approve"><summary>Aprobar v${x.v}</summary><form method="post" action="/bandeja/aprobar">${hidden(base)}<p class="${open ? 'warn' : 'meta'}">Tienes ${plural(open, 'nota abierta', 'notas abiertas')} en esta versión${open ? ': siguen abiertas y le llegan al equipo' : ''}.</p><label>Para aprobar, escribe <b>${esc(variantName(x.identity))}</b><input name="confirm" autocomplete="off" autocapitalize="characters" spellcheck="false" required></label><button class="primary">Aprobar v${x.v}</button></form></details>`;
    const d = draft && draft.projectId === r.projectId && +draft.v === x.v ? draft : null;
    actions += `<details class="note" data-draft="nota:${esc(r.projectId)}:${x.v}:" data-video="${esc(vid)}"${d ? ' open' : ''}><summary>Dejar una nota en v${x.v}</summary><form method="post" action="/bandeja/nota">${hidden(base)}<div class="row"><label>Segundo<input name="atSec" type="number" inputmode="decimal" step="any" min="0" max="${esc(x.durationSec ?? '')}" value="${esc(d?.atSec ?? '0')}" required></label><button type="button" data-now>Segundo actual</button></div><label>Nota<textarea name="text" maxlength="2000" rows="3" required>${esc(d?.text ?? '')}</textarea></label><button class="primary">Enviar nota</button></form></details>`;
  }
  return `<figure class="card">
<figcaption><b>v${x.v}</b> · ${esc(day(x.createdAt))} · ${esc(clock(x.durationSec ?? 0))}${tag ? ` <span class="tag">${tag}</span>` : ''}</figcaption>
${video}
<p class="badges"><span class="badge qc-${cls(qc.state)}">${esc(qc.label)}</span> <span class="badge st-${cls(label)}">${esc(label)}</span></p>
${x.approval ? `<p class="meta">Aprobada por ${esc(x.approval.by)} · ${esc(day(x.approval.at))}</p>` : ''}${findings}${actions}
</figure>`;
}

function noteItem(r, x, n, {owner, reviewer, csrf}) {
  const base = {csrf, project: r.projectId, v: x.v, note: n.id};
  const step = (name, label, extra = '') => `<form method="post" action="/bandeja/nota/estado">${hidden({...base, step: name})}${extra}<button>${label}</button></form>`;
  let actions = '';
  if (reviewer && n.state === 'resuelta') actions += step('verificar', 'Verificar: está arreglada');
  if (owner && n.state === 'clasificada') actions += step('confirmar', 'Confirmar');
  if (owner && ['abierta', 'clasificada', 'confirmada'].includes(n.state)) actions += `<details><summary>Descartar</summary>${step('descartar', 'Descartar la nota', '<label>Razón (la ve el cliente)<textarea name="reason" maxlength="500" rows="2" required></textarea></label>')}</details>`;
  return `<li class="n-${cls(n.state)}"><p class="meta"><b>v${n.v} · ${esc(noteClock(n.atSec))}</b> · <span class="badge st-${cls(n.state)}">${esc(n.state)}${n.resolvedIn ? ` en v${n.resolvedIn}` : ''}</span>${n.afterApproval ? ' <span class="badge flag">nota después de aprobar</span>' : ''} · ${esc(n.by)}</p>
<p class="text">${esc(n.text)}</p>${n.reason ? `<p class="meta">Descartada: ${esc(n.reason)}</p>` : ''}${owner && n.anchor ? `<p class="meta">clip ${esc(n.anchor.clipId)} · ${esc(n.anchor.src)} @ ${esc(n.anchor.srcSec)} s${n.anchor.wordId ? ` · palabra ${esc(n.anchor.wordId)}` : ''}</p>` : ''}${actions}</li>`;
}

function variantBlock(r, o) {
  const {state, delivered} = variantState(r.versions);
  const newest = r.versions.reduce((m, x) => (!m || x.v > m.v ? x : m), null);
  // the delivered version next to the newest — and the one a note sent back after an error was for
  const shown = [r.versions.find((x) => x.v === delivered), newest, o.draft?.projectId === r.projectId && r.versions.find((x) => x.v === +o.draft.v)].filter((x, i, a) => x && a.indexOf(x) === i);
  const notes = r.versions.flatMap((x) => (x.notes ?? []).map((n) => [x, n])).sort((a, b) => b[0].v - a[0].v || a[1].atSec - b[1].atSec);
  const open = notes.filter(([, n]) => n.state !== 'verificada' && n.state !== 'descartada').length;
  return `<article class="variant" id="${esc(r.projectId)}">
<header><h3>${esc(r.stem)}</h3><span class="badge st-${cls(state)}">${esc(state === 'aprobada' ? `aprobada = v${delivered}` : state)}</span></header>
${shown.length ? `<div class="cards">${shown.map((x) => versionCard(r, x, {...o, delivered, newest})).join('\n')}</div>` : `<p class="empty">Todavía no hay versión de ${esc(r.stem)}.</p>`}
${notes.length ? `<section class="notes"><h4>Notas · ${plural(open, 'abierta', 'abiertas')}</h4><ul>${notes.map(([x, n]) => noteItem(r, x, n, o)).join('\n')}</ul></section>` : ''}
</article>`;
}

// the page: g = the session (user, role), rows (bandejaRows), inbox (the owner's, else null), csrf (csrfToken),
// flash / error (a line at the top), draft (a note sent back after an error: {projectId, v, atSec, text})
export function bandejaPage({g, rows, inbox = null, csrf, flash = null, error = null, draft = null}) {
  const owner = g.role === 'owner', reviewer = g.role === 'reviewer';
  const o = {owner, reviewer, csrf, draft};
  const groups = new Map(); // client + G → rows
  for (const r of rows) { const k = `${r.identity.client.toUpperCase()} · G${r.identity.script}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
  const pending = (inbox ?? []).filter((i) => i.kind !== 'metrica'), metric = (inbox ?? []).filter((i) => i.kind === 'metrica');
  const inboxHtml = !inbox ? '' : `<section class="inbox" aria-labelledby="inbox-h"><h2 id="inbox-h">Pendientes <span class="count">${pending.length}</span></h2>
${pending.length ? `<ul>${pending.map((i) => `<li><span class="kind">${esc(KIND[i.kind] ?? i.kind)}</span> ${i.projectId ? `<a href="#${esc(i.projectId)}">${esc(i.text)}</a>` : esc(i.text)}</li>`).join('\n')}</ul>` : '<p class="empty">Nada pendiente.</p>'}
${metric.map((i) => `<p class="meta">${esc(i.text)}</p>`).join('')}</section>`;
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<title>Bandeja${pending.length ? ` (${pending.length})` : ''}</title>
<style>
:root{color-scheme:dark;--bg:#0b0b0c;--card:#141417;--line:#26262c;--fg:#e8e8ea;--mut:#a0a0a8;--ok:#62d68f;--warn:#f2c14e;--bad:#ff8080;--acc:#8ab4ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1040px;margin:0 auto;padding:12px 16px calc(32px + env(safe-area-inset-bottom))}
.top{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px}
h1{font-size:19px;margin:4px 0}
h2{font-size:13px;font-weight:600;color:var(--mut);text-transform:uppercase;letter-spacing:.04em;margin:22px 0 4px}
h3{font-size:16px;margin:0;overflow-wrap:anywhere}
h4{font-size:13px;color:var(--mut);margin:14px 0 4px;font-weight:600}
a{color:var(--acc)}
.flash,.err{padding:10px 12px;border-radius:8px;margin:10px 0}
.flash{background:#12301f;color:var(--ok)}
.err{background:#3a1616;color:var(--bad)}
.inbox{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:4px 14px 10px;margin-top:10px}
.inbox ul,.notes ul{list-style:none;margin:0;padding:0}
.inbox li,.notes li{padding:10px 0;border-top:1px solid var(--line);overflow-wrap:anywhere}
.kind{display:block;font-size:12px;color:var(--warn);text-transform:uppercase;letter-spacing:.03em}
.count{display:inline-block;min-width:24px;padding:0 7px;border-radius:999px;background:var(--warn);color:#111;text-align:center}
.variant{border-top:1px solid var(--line);padding:14px 0}
.variant>header{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.cards{display:grid;gap:16px;margin-top:12px}
@media (min-width:720px){.cards{grid-template-columns:repeat(2,minmax(0,380px))}}
.card{margin:0;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px}
figcaption{margin:0 0 8px}
video{display:block;width:100%;aspect-ratio:9/16;max-height:72vh;background:#000;border-radius:8px;object-fit:contain}
.gone,.empty{color:var(--mut)}
.tag{font-size:12px;color:var(--acc)}
.badges{margin:8px 0 4px}
.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12.5px;border:1px solid currentColor;color:var(--mut)}
.qc-superado,.st-aprobada,.st-verificada{color:var(--ok)}
.qc-hallazgos,.qc-en-curso,.st-cambios,.st-abierta,.st-clasificada,.st-confirmada,.st-resuelta,.flag{color:var(--warn)}
.qc-no-disponible,.qc-sin-qc{color:var(--bad)}
.meta{color:var(--mut);font-size:13px;margin:4px 0}
.warn{color:var(--warn);margin:4px 0}
.text{white-space:pre-wrap;overflow-wrap:anywhere;margin:4px 0}
details{margin-top:8px}
summary{min-height:44px;display:flex;align-items:center;cursor:pointer;color:var(--acc)}
summary::before{content:'▸';margin-right:8px}
details[open]>summary::before{content:'▾'}
form{margin:4px 0}
label{display:grid;gap:4px;font-size:13px;color:var(--mut);margin:8px 0}
input,textarea{font:inherit;width:100%;padding:10px;border-radius:8px;border:1px solid #3a3a42;background:#0f0f12;color:var(--fg)}
.row{display:flex;gap:8px;align-items:end}
.row label{flex:1;margin:0}
button{font:inherit;min-height:44px;padding:9px 14px;border-radius:8px;border:1px solid #3a3a42;background:#1d1d22;color:var(--fg);cursor:pointer}
button.primary{background:#2f6fef;border-color:#2f6fef;color:#fff}
button:disabled{opacity:.5;cursor:not-allowed}
.off{color:var(--mut);font-size:13px}
.top form{margin:0}
</style>
</head>
<body>
<main>
<div class="top"><h1>Bandeja</h1><form method="post" action="/bandeja/salir">${hidden({csrf})}<span class="meta">${esc(g.user)}${owner ? ' · owner' : ''}</span> <button>Salir</button></form></div>
${flash ? `<p class="flash" role="status">${esc(flash)}</p>` : ''}${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
${inboxHtml}
${rows.length ? [...groups].map(([k, list]) => `<h2>${esc(k)}</h2>\n${list.map((r) => variantBlock(r, o)).join('\n')}`).join('\n') : `<p class="empty">${g.role ? 'Todavía no hay reels de tus clientes.' : `${esc(g.user)} no tiene rol en REEL_USER_ROLES: no ve proyectos de clientes.`}</p>`}
</main>
<script>${BANDEJA_JS}</script>
</body>
</html>
`;
}

// the session's CSRF token: an HMAC of its cookie (it changes with every login, and a page of one session is worthless
// to another)
const csrfToken = (secret, req) => crypto.createHmac('sha256', String(secret)).update(`reel-csrf.v1.${parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? ''}`).digest('base64url');
const csrfOk = (want, got) => typeof got === 'string' && got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
// a second as a phone sends it: "20.4", "20,4"
const seconds = (s) => { const t = String(s ?? '').trim().replace(',', '.'); return /^\d+(\.\d+)?$/.test(t) ? +t : NaN; };

// the POST steps (E-8): one function each with its own input; the step of scripts/review-states.mjs checks the state
function postApprove(x, actor, {form, at, ipHash, userAgent}) { approve(x, actor, {name: form.confirm, at, ipHash, userAgent}); return 'aprobada'; }
function postRevoke(x, actor, {form, at}) { revoke(x, actor, {reason: form.reason, at}); return 'revocada'; }
function postNote(x, actor, {form, at, publicDir}) {
  const atSec = seconds(form.atSec);
  // anchored on the version as it was rendered — its snapshot, never the live project
  const anchor = x.snapshot && Number.isFinite(atSec) ? anchorAt(readJson(path.join(publicDir, x.snapshot)), atSec) : null;
  addNote(x, actor, {atSec, text: form.text, anchor, at});
  return 'nota';
}
function postNoteStep(x, actor, {form, at}) {
  if (!['confirmar', 'descartar', 'verificar'].includes(form.step)) throw Object.assign(new Error('Paso desconocido'), {status: 400});
  return moveNote(x, String(form.note ?? ''), form.step, actor, {at, reason: form.reason}).state;
}
const POSTS = {'/bandeja/aprobar': postApprove, '/bandeja/revocar': postRevoke, '/bandeja/nota': postNote, '/bandeja/nota/estado': postNoteStep};

// `g` = the gate's answer (kind 'bandeja': the session user, or none); login = public mode (/login exists); secret = the
// session key (CSRF, the approval's ipHash); limiter = createLoginLimiter-shaped, per user; disk() → {freeDiskMb,
// minDiskMb}. → true (every /bandeja request is answered here)
export async function handleBandeja(req, res, url, {publicDir, g, login = false, secret, hops = 0, publicUrl = process.env.REEL_PUBLIC_URL, limiter = null, disk = () => null, now = Date.now, log = console.error}) {
  const send = (status, headers, body) => { res.writeHead(status, {...PRIVACY_HEADERS, 'Cache-Control': 'no-store', ...headers}); res.end(req.method === 'HEAD' ? undefined : body); return true; };
  const say = (status, msg, headers = {}) => send(status, {'Content-Type': 'text/plain; charset=utf-8', ...headers}, msg);
  const route = url.pathname.replace(/\/+$/, '');
  const read = req.method === 'GET' || req.method === 'HEAD';
  if (route !== '/bandeja' && route !== '/bandeja/salir' && !Object.hasOwn(POSTS, route)) return say(404, 'Not found');
  if (route === '/bandeja' ? !read : req.method !== 'POST') return send(405, {Allow: route === '/bandeja' ? 'GET, HEAD' : 'POST'});
  if (g?.via !== 'session' || !g.user) {
    if (read && login) return send(303, {Location: '/login?next=%2Fbandeja'});
    return say(403, read ? 'La bandeja necesita login: solo en la VM (modo público, REEL_PUBLIC=1).' : 'solo con login en la VM');
  }
  const dir = path.join(publicDir, 'reviews');
  const sees = (clients) => seesClient(g, clients);
  const csrf = csrfToken(secret, req);
  const page = (status, extra = {}) => {
    const rows = bandejaRows(publicDir, sees);
    const inbox = g.role === 'owner' ? ownerInbox(rows, {disk: disk()}) : null;
    if (inbox) logInbox(inbox, log);
    return send(status, {'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': BANDEJA_CSP}, bandejaPage({g, rows, inbox, csrf, ...extra}));
  };
  if (read) return page(200, {flash: FLASH[url.searchParams.get('ok')] ?? null});

  // Origin: another site's is refused. This page's Referrer-Policy no-referrer makes the browser send `Origin: null` on its own
  // form posts (Fetch: no-referrer serializes the origin as null), so null passes here and the CSRF token decides; a
  // cross-site post carries no session cookie anyway (SameSite=Lax)
  if (req.headers.origin !== 'null' && !sameSite(req, {hops, publicUrl})) return say(403, 'Petición de otro sitio rechazada.');
  const wait = limiter?.attempt(g.user, now()) || 0;
  if (wait) return say(429, 'Demasiadas acciones seguidas: espera un momento.', {'Retry-After': String(wait)});
  let form;
  try { form = Object.fromEntries(new URLSearchParams(await readBody(req, 16384))); } catch (e) { return say(e.status || 400, 'Petición inválida.'); }
  if (!csrfOk(csrf, form.csrf)) return say(403, 'La página caducó: recárgala e inténtalo otra vez.');
  // sign out from this page: POST /logout wants an Origin of this site, which this page's no-referrer never sends
  if (route === '/bandeja/salir') return send(303, {Location: '/login', 'Set-Cookie': cookieHeader(req, '', 0, login)});
  const projectId = String(form.project ?? ''), v = Number(form.v);
  const draft = route === '/bandeja/nota' ? {projectId, v, atSec: form.atSec, text: form.text} : null;
  // the version's client, read before the row: humanOnly (E-2) decides who may act on it; the step re-checks in the row
  const client = /^[\w-]+$/.test(projectId) && Number.isInteger(v) ? loadReviews(dir, projectId).versions.find((x) => x.v === v)?.identity?.client : null;
  if (!client || !sees(projectClients(publicDir, projectId))) return page(404, {error: 'Esa versión no existe o no es de tus clientes.'});
  const who = humanOnly(g, {client});
  if (!who.ok) return page(403, {error: who.error, draft});
  const ipHash = crypto.createHash('sha256').update(`${secret}|${clientIp(req, hops)}`).digest('hex').slice(0, 16);
  let done;
  try {
    const x = await withVersion(dir, projectId, v, (y) => { done = POSTS[route](y, actorOf(g), {form, at: new Date(now()).toISOString(), ipHash, userAgent: req.headers['user-agent'], publicDir}); });
    if (!x) return page(404, {error: 'Esa versión ya no existe.'});
  } catch (e) {
    if (!e.status) throw e;
    return page(e.status, {error: e.message, draft});
  }
  try { refreshInbox({publicDir, disk: disk(), log}); } catch (e) { log(`[owner-inbox] not refreshed: ${e.message}`); }
  return send(303, {Location: `/bandeja?ok=${done}#${projectId}`});
}
