// File uploads with real progress. fetch() cannot report upload progress, so
// this goes through XMLHttpRequest (upload.onprogress). The backend answers
// only after it has transcoded the file, so an upload has two phases: bytes
// going up (a %), then the server processing them (no % to show).

export type UploadPhase = 'queued' | 'uploading' | 'processing' | 'done' | 'error';

export type UploadItem = {
  key: string;
  name: string;
  size: number;
  loaded: number;
  phase: UploadPhase;
  error?: string;
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
