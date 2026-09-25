// File uploads with real progress. fetch() cannot report upload progress, so
// this goes through XMLHttpRequest (upload.onprogress). A clip upload has two
// phases: bytes going up (a %), then the server processing them — the backend
// answers 202 {jobId} as soon as the file is on disk and the editor polls the
// ingest job (its own %, a label) until the clip is ready.

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

// POST the file as the raw body; resolves with the parsed JSON answer, rejects
// with a readable Error (never silently).
export function uploadFile<T>(
  url: string,
  file: File,
  on: {progress?: (loaded: number, total: number) => void; uploaded?: () => void} = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => on.progress?.(e.loaded, e.lengthComputable ? e.total : file.size);
    xhr.upload.onload = () => { on.progress?.(file.size, file.size); on.uploaded?.(); };
    xhr.onerror = () => reject(new Error(uploadError(0, '', '')));
    xhr.onabort = () => reject(new Error('Upload cancelled'));
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(uploadError(xhr.status, xhr.statusText, xhr.responseText)));
      try {
        resolve(JSON.parse(xhr.responseText) as T);
      } catch {
        reject(new Error(`${xhr.status} — the server answered with something that is not JSON`));
      }
    };
    xhr.send(file);
  });
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

// Upload a clip to /api/add-clip and wait for the server to make it: the 202
// {jobId} is polled; an answer with the clip itself (an older backend) is used as is.
export async function uploadClip<T extends {id?: string}>(
  file: File,
  on: {progress?: (loaded: number, total: number) => void; uploaded?: () => void; job?: (jobId: string) => void; processing?: (progress: number, label: string) => void} = {},
): Promise<T> {
  const r = await uploadFile<{jobId?: string; id?: string; error?: string}>('/api/add-clip?name=' + encodeURIComponent(file.name), file, on);
  if (r?.jobId) {
    on.job?.(r.jobId);
    return waitIngest<T>(r.jobId, {progress: on.processing});
  }
  if (!r?.id) throw new Error(r?.error || 'the server did not return a clip');
  return r as T;
}

// Ingest jobs the server is still processing, kept in localStorage so a tab
// that closed or reloaded after the upload picks its clips up again.
export type PendingIngest = {jobId: string; name: string; size: number};
const PENDING_KEY = 'reel.pendingIngests';
export function pendingIngests(store: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.localStorage) {
  const list = (): PendingIngest[] => {
    try {
      const v = JSON.parse(store?.getItem(PENDING_KEY) ?? '[]');
      return Array.isArray(v) ? v.filter((p) => typeof p?.jobId === 'string') : [];
    } catch {
      return [];
    }
  };
  const save = (l: PendingIngest[]) => { try { store?.setItem(PENDING_KEY, JSON.stringify(l)); } catch { /* storage full or off */ } };
  return {
    list,
    add: (p: PendingIngest) => save([...list().filter((x) => x.jobId !== p.jobId), p]),
    remove: (jobId: string) => save(list().filter((x) => x.jobId !== jobId)),
  };
}
