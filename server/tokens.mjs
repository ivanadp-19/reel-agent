// Per-user API tokens for the `reel` CLI (cli/reel.mjs): one per person or agent,
// revocable one by one, stored on disk as sha256 only (REEL_TOKENS_FILE, default
// <root>/.reel-tokens.json, mode 0600). The secret exists once — in the answer to
// its creation — and the CLI reads it from the user's own ~/.config/reel/token.
// Created / listed / revoked through /api/tokens by an admin: the backend token
// (REEL_BACKEND_TOKEN / .backend-token) or a user token made with admin; a user signed
// in to the editor makes and revokes their own at /cli-token (server/cli-tokens.mjs).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const TOKEN_PREFIX = 'reel_';
export const USER_RE = /^[A-Za-z_][\w.-]{0,31}$/;
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest();

export function createTokenStore(file) {
  let cache = [], stamp = '';
  const read = () => {
    let st;
    try { st = fs.statSync(file); } catch { cache = []; stamp = ''; return cache; }
    const s = `${st.mtimeMs}:${st.size}`;
    if (s !== stamp) { cache = JSON.parse(fs.readFileSync(file, 'utf8')).tokens ?? []; stamp = s; }
    return cache;
  };
  const write = (tokens) => {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({tokens}, null, 2), {mode: 0o600});
    fs.renameSync(tmp, file);
    stamp = '';
  };
  const pub = ({hash, ...t}) => t;
  return {
    list: () => read().map(pub),
    create({user, admin = false, uid = null, now = new Date()} = {}) {
      if (!USER_RE.test(String(user ?? ''))) throw new Error('user: letters, digits, _ . - (≤ 32, not starting with a digit)');
      const token = TOKEN_PREFIX + crypto.randomBytes(24).toString('base64url');
      const rec = {id: crypto.randomBytes(4).toString('hex'), user, admin: !!admin, uid: Number.isInteger(uid) && uid >= 0 ? uid : null, hash: sha(token).toString('hex'), createdAt: now.toISOString()};
      write([...read(), rec]);
      return {...pub(rec), token};
    },
    // by token id, or every live token of a user (idOnly: the id alone — an id that
    // happens to be a user's name never takes that user's tokens with it)
    revoke(idOrUser, now = new Date(), {idOnly = false} = {}) {
      const gone = [];
      const tokens = read().map((t) => {
        if (t.revokedAt || (t.id !== idOrUser && (idOnly || t.user !== idOrUser))) return t;
        gone.push(t.id);
        return {...t, revokedAt: now.toISOString()};
      });
      if (gone.length) write(tokens);
      return gone;
    },
    // the live record of a presented token, compared in constant time
    find(given) {
      if (typeof given !== 'string' || !given.startsWith(TOKEN_PREFIX)) return null;
      const g = sha(given);
      let hit = null;
      for (const t of read()) if (!t.revokedAt && crypto.timingSafeEqual(Buffer.from(t.hash, 'hex'), g)) hit = t;
      return hit ? pub(hit) : null;
    },
  };
}

// A server path a user token may have the backend ingest (`reel clips add` without the
// upload): a regular file that user could read anyway — owned by the token's uid, or
// readable by everyone down directories everyone can traverse. The backend reads more
// than its users; it must not read another user's files on their behalf. The file is
// opened here (O_NONBLOCK: a FIFO cannot hang the backend) and ffmpeg reads the open
// descriptor (/proc/<pid>/fd/<n> on Linux), so a path swapped after the check still
// reads the file that was checked. → {path, close} or null.
export function openForUser(file, uid, {pid = process.pid, linux = process.platform === 'linux'} = {}) {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK); } catch { return null; }
  try {
    const st = fs.fstatSync(fd);
    const real = linux ? fs.readlinkSync(`/proc/self/fd/${fd}`) : fs.realpathSync(file);
    const everyone = () => {
      if (!(st.mode & 0o004)) return false;
      for (let d = path.dirname(real); ; d = path.dirname(d)) {
        if (!(fs.statSync(d).mode & 0o001)) return false;
        if (d === path.dirname(d)) return true;
      }
    };
    if (!st.isFile() || !((uid != null && st.uid === uid) || everyone())) { fs.closeSync(fd); return null; }
    return {path: linux ? `/proc/${pid}/fd/${fd}` : real, close: () => { try { fs.closeSync(fd); } catch {} }};
  } catch {
    fs.closeSync(fd);
    return null;
  }
}
