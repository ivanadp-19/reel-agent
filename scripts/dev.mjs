// `npm start` — run the whole app with one command:
//   backend (port 3333) + editor frontend (vite, port 5173)
// In public mode (REEL_PUBLIC=1: the VM, Railway, or localhost to try the login and the bandeja) the backend alone:
// it serves the built editor (`npx vite build` first) behind its gate — a vite dev server would serve public/, a
// client's /reviews and /clients included, to any local user, with no login.
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
fs.mkdirSync(path.join(ROOT, 'public'), {recursive: true}); // vite needs it on a fresh clone

const PUBLIC_MODE = process.env.REEL_PUBLIC === '1';
if (PUBLIC_MODE && !fs.existsSync(path.join(ROOT, 'editor', 'dist', 'index.html'))) console.warn('REEL_PUBLIC=1: no editor/dist — run `npx vite build`, the backend serves the editor from it');
const procs = [
  spawn('node', ['server/index.mjs'], {cwd: ROOT, stdio: 'inherit'}),
  ...(PUBLIC_MODE ? [] : [spawn('npx', ['vite'], {cwd: ROOT, stdio: 'inherit'})]),
];

// our pid for `npm run stop` (stops by pid, never by a pkill pattern)
const PID = path.join(ROOT, '.dev.pid');
fs.writeFileSync(PID, String(process.pid));
process.once('exit', () => { try { if (fs.readFileSync(PID, 'utf8') === String(process.pid)) fs.rmSync(PID); } catch {} });

const killAll = () => procs.forEach((p) => { try { p.kill('SIGTERM'); } catch {} });
process.on('SIGINT', () => { killAll(); process.exit(0); });
process.on('SIGTERM', () => { killAll(); process.exit(0); });
// if either process dies on its own, stop the other one too and fail — a backend killed by a signal (code null) or
// ending 0 included, so systemd's Restart=on-failure restarts the app; `npm run stop` signals this process first (above: 0)
procs.forEach((p) => p.on('exit', (code) => { killAll(); process.exit(code || 1); }));
