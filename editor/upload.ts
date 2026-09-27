// Clip uploads. Two phases: the bytes go up in 8 MB parts (PUT /api/uploads/<id>?offset=n, server/uploads.mjs —
// the reel CLI's resumable upload), so no request outlives a proxy's timeout and a cut network or a reload goes on
// from where the server's part ends; then the server makes the clip as a job (POST /api/add-clip?upload=<id>&async=1
// → 202 {jobId}) and the editor polls it (its own %, a label) until the clip is ready.

export type UploadPhase = 'queued' | 'uploading' | 'processing' | 'done' | 'error';

export type UploadItem = {
  key: string;
  name: string;
  size: number;
  loaded: number;
  phase: UploadPhase;
  error?: string;
  progress?: number; // server-side processing, 0–100
  label?: string; // what the server is doing: Probing, Transcoding, Remuxing, Making thumbnail
};

export const isVideoFile = (f: {name: string; type: string}) =>
  f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|avi|mts)$/i.test(f.name);

export const fmtMB = (bytes: number) => `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MB`;

export const pct = (loaded: number, total: number) => (total > 0 ? Math.min(100, Math.floor((loaded / total) * 100)) : 0);

// A readable message out of a failed response: the server's {error, detail}
// when it sent JSON, else the status line and the start of the body.
export function uploadError(status: number, statusText: string, body: string): string {
  if (status === 0) return 'Network error — the upload was interrupted or the backend is not reachable';
  let msg = '';
  try {
    const j = JSON.parse(body);
    // detail is often an ffmpeg stderr tail: its last line is the one that says what went wrong
    const detail = typeof j?.detail === 'string' ? j.detail.trim().split(/\r?\n/).filter(Boolean).pop() : '';
    msg = [j?.error, detail].filter((s) => typeof s === 'string' && s.trim()).join(': ');
  } catch {
    msg = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  if (status === 401 || status === 403) msg ||= 'not signed in';
  if (status === 413) msg ||= 'file too large';
  return `${status}${statusText ? ' ' + statusText : ''}${msg ? ' — ' + msg : ''}`;
}

const parse = (s: string) => { try { return JSON.parse(s); } catch { return null; } };
export const CHUNK = 8 * 2 ** 20;

// the part's id on the server: the same file (name, size, last change) is the same part, so the file picked
// again after a reload goes on where it stopped
export async function uploadId(f: {name: string; size: number; lastModified: number}): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${f.name}\n${f.size}\n${f.lastModified}`));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

type Net = {fetchFn?: typeof fetch; chunk?: number; retries?: number; backoffMs?: number; everyMs?: number};
// Send `file` as the part `id`, a slice at a time from where the server's part ends (as cli/reel.mjs uploadFile
// does). 409 offset_mismatch (a slice that landed though its answer was lost): go on from the server's size. A
// dropped PUT or a 5xx: wait, ask where the part stands, go on. 507 low_disk and the other 4xx stop with the reason
export async function uploadParts(file: Blob, id: string, on: {progress?: (loaded: number, total: number) => void} = {}, {fetchFn = fetch, chunk = CHUNK, retries = 8, backoffMs = 500}: Net = {}): Promise<void> {
  const where = async () => {
    const r = await fetchFn(`/api/uploads/${id}`);
    const size = r.ok ? parse(await r.text())?.size : null;
    if (!Number.isInteger(size)) throw new Error(uploadError(r.status, r.statusText, ''));
    return size as number;
  };
  let size = await where();
  for (let fails = 0; size < file.size; ) {
    on.progress?.(size, file.size);
    let r: Response | null = null;
    try {
      r = await fetchFn(`/api/uploads/${id}?offset=${size}`, {method: 'PUT', headers: {'content-type': 'application/octet-stream'}, body: file.slice(size, Math.min(file.size, size + chunk))});
    } catch { /* the network dropped: below */ }
    const text = r ? await r.text().catch(() => '') : '';
    const j = parse(text);
    if (r?.ok && Number.isInteger(j?.size)) { size = j.size; fails = 0; continue; }
    if (r?.status === 409 && j?.code === 'offset_mismatch' && Number.isInteger(j.size)) { size = j.size; continue; }
    const why = r ? uploadError(r.status, r.statusText, text) : uploadError(0, '', '');
    if ((r && (r.status < 500 || r.status === 507)) || ++fails > retries) throw new Error(why);
    await wait(Math.min(15e3, backoffMs * 2 ** fails));
    size = await where().catch(() => size); // still down: the PUT answers 409 with the size once it is back
  }
  on.progress?.(file.size, file.size);
}

// GET /api/add-clip/<jobId>
export type IngestStatus = {status: 'running' | 'done' | 'error' | 'unknown'; progress?: number; label?: string; clip?: {id?: string}; error?: string};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Poll an ingest job every `everyMs` until it is done (resolves the clip) or
// failed (rejects with its message). A few failed polls in a row are tolerated
// (a proxy hiccup must not lose a clip the server is still making).
export async function waitIngest<T>(
  jobId: string,
  on: {progress?: (progress: number, label: string) => void} = {},
  {fetchFn = fetch, everyMs = 1000, maxMisses = 10}: {fetchFn?: typeof fetch; everyMs?: number; maxMisses?: number} = {},
): Promise<T> {
  let misses = 0;
  for (;;) {
    let s: IngestStatus | null = null;
    let miss = '';
    try {
      const r = await fetchFn('/api/add-clip/' + encodeURIComponent(jobId));
      if (r.ok) s = (await r.json()) as IngestStatus;
      else miss = uploadError(r.status, r.statusText, await r.text().catch(() => ''));
    } catch (e) {
      miss = e instanceof TypeError ? uploadError(0, '', '') : e instanceof Error ? e.message : String(e);
    }
    if (s) {
      misses = 0;
      if (s.status === 'done') {
        if (!s.clip?.id) throw new Error('the server did not return a clip');
        return s.clip as T;
      }
      if (s.status === 'error') throw new Error(s.error || 'processing failed on the server');
      if (s.status === 'unknown') throw new Error('The server no longer knows this upload (it restarted?) — upload the file again');
      on.progress?.(s.progress ?? 0, s.label ?? 'Processing');
    } else if (++misses >= maxMisses) {
      throw new Error(`Lost contact with the server while it processed the clip — ${miss}`);
    }
    await wait(everyMs);
  }
}

// Upload a clip in parts, have the server make it (202 {jobId}) and wait for it. upload(id): the part's id, known
// before a byte goes up (Start.tsx remembers it, so a reload can say the file resumes when picked again)
export async function uploadClip<T extends {id?: string}>(
  file: File,
  on: {progress?: (loaded: number, total: number) => void; uploaded?: () => void; upload?: (id: string) => void; job?: (jobId: string) => void; processing?: (progress: number, label: string) => void} = {},
  net: Net = {},
): Promise<T> {
  const {fetchFn = fetch} = net;
  const id = await uploadId(file);
  on.upload?.(id);
  await uploadParts(file, id, on, net);
  on.uploaded?.();
  const r = await fetchFn(`/api/add-clip?name=${encodeURIComponent(file.name)}&upload=${id}&size=${file.size}&async=1`, {method: 'POST'});
  const text = await r.text();
  const jobId = parse(text)?.jobId;
  if (!r.ok || typeof jobId !== 'string') throw new Error(uploadError(r.status, r.statusText, text));
  on.job?.(jobId);
  return waitIngest<T>(jobId, {progress: on.processing}, {fetchFn, everyMs: net.everyMs});
}

// Uploads the server has not made into clips yet, kept in localStorage so a tab that closed or reloaded picks
// them up again: with a jobId the server is making the clip (it is waited for); with only the part's id
// (`upload`) the bytes were still going up — the same file picked again goes on where it stopped.
export type PendingIngest = {jobId?: string; upload?: string; name: string; size: number};
const PENDING_KEY = 'reel.pendingIngests';
const keyOf = (p: PendingIngest) => p.upload ?? p.jobId;
export function pendingIngests(store: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.localStorage) {
  const list = (): PendingIngest[] => {
    try {
      const v = JSON.parse(store?.getItem(PENDING_KEY) ?? '[]');
      return Array.isArray(v) ? v.filter((p) => typeof p?.jobId === 'string' || typeof p?.upload === 'string') : [];
    } catch {
      return [];
    }
  };
  const save = (l: PendingIngest[]) => { try { store?.setItem(PENDING_KEY, JSON.stringify(l)); } catch { /* storage full or off */ } };
  return {
    list,
    add: (p: PendingIngest) => save([...list().filter((x) => keyOf(x) !== keyOf(p)), p]),
    remove: (key: string) => save(list().filter((x) => keyOf(x) !== key)),
  };
}
