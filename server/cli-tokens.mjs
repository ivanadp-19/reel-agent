// Self-service CLI tokens: a user signed in to the editor (the form login's session
// cookie, or basic auth — the two ways a browser holds a user in public mode) makes and
// revokes their OWN `reel` tokens (server/tokens.mjs) without an admin:
//   GET  /cli-token                     → the page (self-contained HTML, inline CSS/JS)
//   GET  /api/cli-tokens                → {user, tokens: [{id, createdAt, revokedAt}]} — the caller's own
//   POST /api/cli-tokens                → {id, token} — non-admin, user = the session's; the only time the secret is sent
//   POST /api/cli-tokens/<id>/revoke    → {id, revokedAt} — own tokens only (404 otherwise); again is not an error
// A token or the backend token does not open these routes (401): a token never mints
// another token. The POSTs need an Origin (or Referer) of this site (session.mjs
// sameSite) — a browser sends the cookie and basic auth to any site's POST. The secret
// is never logged; at rest it is a sha256 in the token store.
import crypto from 'node:crypto';
import {sameSite} from './session.mjs';

export const CLI_TOKEN_PAGE = '/cli-token';
export const MAX_LIVE = 10; // live tokens per user: revoke one to make another
export const isCliTokenPath = (pathname) => pathname === CLI_TOKEN_PAGE || pathname === '/api/cli-tokens' || pathname.startsWith('/api/cli-tokens/');
const BROWSER_VIA = new Set(['session', 'basic']);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const own = (users, user) => users.list().filter((t) => t.user === user).map(({id, createdAt, revokedAt}) => ({id, createdAt, revokedAt: revokedAt ?? null}));

// `g` = the gate's answer; `users` = the token store; `base` = the address the CLI should use (REEL_URL)
export function handleCliTokens(req, res, url, g, {users, base, hops = 0, publicUrl, log = console.log} = {}) {
  const send = (status, headers, body) => { res.writeHead(status, {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers}); res.end(body); };
  const json = (status, obj) => send(status, {'Content-Type': 'application/json'}, JSON.stringify(obj));
  const page = url.pathname === CLI_TOKEN_PAGE;

  if (!BROWSER_VIA.has(g.via) || !g.user) {
    const hint = `sign in to the editor in a browser and open ${CLI_TOKEN_PAGE} — a token cannot make tokens`;
    if (page) return send(401, {'Content-Type': 'text/plain; charset=utf-8'}, `401: ${hint}\n`);
    return json(401, {error: 'browser session required', code: 'session_required', hint});
  }
  const user = g.user;

  if (page) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, {Allow: 'GET, HEAD'}, '');
    const nonce = crypto.randomBytes(16).toString('base64');
    return send(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    }, req.method === 'HEAD' ? '' : cliTokenPage({user, base, nonce}));
  }

  if (url.pathname === '/api/cli-tokens') {
    if (req.method === 'GET') return json(200, {user, tokens: own(users, user)});
    if (req.method !== 'POST') return json(405, {error: 'method not allowed'});
    if (!sameSite(req, {hops, publicUrl})) return json(403, {error: 'cross-site request refused', code: 'forbidden'});
    if (own(users, user).filter((t) => !t.revokedAt).length >= MAX_LIVE) return json(409, {error: `${MAX_LIVE} live tokens already`, code: 'too_many', hint: 'revoke one you no longer use'});
    let rec;
    try { rec = users.create({user, admin: false}); } catch (e) { return json(400, {error: e.message, code: 'bad_request'}); }
    log(`cli-token: ${user} created ${rec.id}`);
    return json(200, {id: rec.id, token: rec.token});
  }

  const m = url.pathname.match(/^\/api\/cli-tokens\/([\w-]{1,64})\/revoke$/);
  if (!m) return json(404, {error: 'not found'});
  if (req.method !== 'POST') return json(405, {error: 'method not allowed'});
  if (!sameSite(req, {hops, publicUrl})) return json(403, {error: 'cross-site request refused', code: 'forbidden'});
  // someone else's token answers like a missing one: ids of other users are not confirmed
  const t = own(users, user).find((x) => x.id === m[1]);
  if (!t) return json(404, {error: 'no such token of yours', code: 'not_found'});
  if (!t.revokedAt) { users.revoke(t.id, new Date(), {idOnly: true}); log(`cli-token: ${user} revoked ${t.id}`); }
  return json(200, {id: t.id, revokedAt: own(users, user).find((x) => x.id === t.id).revokedAt});
}

export function cliTokenPage({user, base, nonce}) {
  // the secret never goes into a command: `read -rs` takes it from the clipboard, out of the shell history
  const save = [
    'mkdir -p ~/.config/reel && chmod 700 ~/.config/reel',
    "(umask 077; read -rsp 'paste token: ' T && printf '%s\\n' \"$T\" > ~/.config/reel/token); echo",
    'chmod 600 ~/.config/reel/token',
    `export REEL_URL=${base}`,
    'reel whoami --json',
  ].join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>CLI tokens · reel-agent</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #111; color: #eee; font: 15px/1.45 system-ui, -apple-system, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 20px; display: grid; gap: 18px; }
  h1 { margin: 0; font-size: 20px; font-weight: 600; }
  h2 { margin: 0 0 8px; font-size: 15px; font-weight: 600; }
  p { margin: 0; color: #bbb; }
  section { padding: 18px; background: #1b1b1b; border: 1px solid #2c2c2c; border-radius: 10px; display: grid; gap: 10px; }
  button { justify-self: start; padding: 8px 14px; border: 0; border-radius: 6px; background: #4a7dff; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  button.small { padding: 4px 10px; font-size: 13px; background: #333; }
  button.danger { background: #7a2e2e; }
  button:disabled { opacity: .5; cursor: default; }
  pre, code { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre { margin: 0; padding: 12px; background: #0b0b0b; border: 1px solid #2c2c2c; border-radius: 6px; overflow-x: auto; white-space: pre; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .secret { word-break: break-all; white-space: pre-wrap; color: #9fe39f; }
  .warn { color: #ffcf6e; }
  .err { color: #ff7a7a; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #2c2c2c; }
  th { color: #999; font-weight: 500; }
  .revoked { color: #777; }
  [hidden] { display: none !important; }
</style></head>
<body><main>
  <h1>CLI tokens</h1>
  <p>Signed in as <b>${esc(user)}</b>. A token lets the <code>reel</code> CLI act as you. Keep it private; revoke it when a machine no longer needs it.</p>
  <section>
    <div class="row"><button id="gen" type="button">Generate token</button><span id="msg" role="status"></span></div>
    <div id="fresh" hidden>
      <p class="warn">Copy it now — it is shown only once.</p>
      <pre id="secret" class="secret"></pre>
      <div class="row"><button id="copyTok" class="small" type="button">Copy token</button></div>
    </div>
  </section>
  <section>
    <h2>Save it on your machine</h2>
    <p>Run these, paste the token when asked (it is not echoed and stays out of your shell history):</p>
    <pre id="cmds">${esc(save)}</pre>
    <div class="row"><button id="copyCmds" class="small" type="button">Copy commands</button></div>
  </section>
  <section>
    <h2>Your tokens</h2>
    <table><thead><tr><th>ID</th><th>Created</th><th>Revoked</th><th></th></tr></thead><tbody id="list"><tr><td colspan="4">…</td></tr></tbody></table>
  </section>
</main>
<script nonce="${nonce}">
(() => {
  const $ = (id) => document.getElementById(id);
  const msg = (text, cls = '') => { $('msg').textContent = text; $('msg').className = cls; };
  const call = async (path, method = 'GET') => {
    const r = await fetch(path, {method, credentials: 'same-origin', headers: {Accept: 'application/json'}});
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
    return body;
  };
  const when = (iso) => (iso ? new Date(iso).toLocaleString() : '');
  const copy = async (text, btn) => {
    try { await navigator.clipboard.writeText(text); const t = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = t; }, 1500); }
    catch { msg('Copy failed — select the text and copy it by hand.', 'err'); }
  };
  async function load() {
    const tbody = $('list');
    let tokens;
    try { ({tokens} = await call('/api/cli-tokens')); } catch (e) { msg(e.message, 'err'); return; }
    tbody.replaceChildren();
    if (!tokens.length) { const tr = tbody.insertRow(); const td = tr.insertCell(); td.colSpan = 4; td.textContent = 'No tokens yet.'; return; }
    for (const t of tokens.slice().reverse()) {
      const tr = tbody.insertRow();
      if (t.revokedAt) tr.className = 'revoked';
      const id = tr.insertCell(); const c = document.createElement('code'); c.textContent = t.id; id.append(c);
      tr.insertCell().textContent = when(t.createdAt);
      tr.insertCell().textContent = when(t.revokedAt);
      const act = tr.insertCell();
      if (!t.revokedAt) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'small danger'; b.textContent = 'Revoke';
        b.onclick = async () => {
          if (!confirm('Revoke token ' + t.id + '? The CLI using it stops working at once.')) return;
          b.disabled = true;
          try { await call('/api/cli-tokens/' + encodeURIComponent(t.id) + '/revoke', 'POST'); msg('Token ' + t.id + ' revoked.'); }
          catch (e) { msg(e.message, 'err'); }
          load();
        };
        act.append(b);
      }
    }
  }
  $('gen').onclick = async () => {
    $('gen').disabled = true;
    try {
      const {id, token} = await call('/api/cli-tokens', 'POST');
      $('secret').textContent = token;
      $('fresh').hidden = false;
      msg('Token ' + id + ' created.');
      load();
    } catch (e) { msg(e.message, 'err'); }
    $('gen').disabled = false;
  };
  $('copyTok').onclick = (e) => copy($('secret').textContent, e.target);
  $('copyCmds').onclick = (e) => copy($('cmds').textContent, e.target);
  load();
})();
</script>
</body></html>`;
}
