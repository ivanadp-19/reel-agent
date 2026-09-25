// Background jobs on the backend (captions, autocut, transcribe, grade, matte):
// POST starts one, GET <route>/<id> reports it. Dead-job (server restart) and
// timeout guards; network hiccups tolerated for a few polls. What a job made comes
// back in its status (`result`), never through a file in public/ that every job shares.
export type JobStatus = {status?: string; label?: string; progress?: number; error?: string; etaSec?: number | null; result?: unknown};

export function pollJob(
  base: string,
  jobId: string,
  onProgress: (s: JobStatus) => void,
  onDone: (result: unknown) => void,
  onFail: (msg: string) => void,
  maxAttempts = 600, // ×1.5s ≈ 15 min (exports pass a higher cap)
): () => void {
  let attempts = 0;
  let netFails = 0;
  const poll = setInterval(async () => {
    attempts++;
    let s: JobStatus;
    try {
      s = await fetch(`${base}/${jobId}`).then((x) => x.json());
      netFails = 0;
    } catch {
      if (++netFails > 5) { clearInterval(poll); onFail('Lost connection to the server'); }
      return;
    }
    if (s.status === 'running') {
      onProgress(s);
      if (attempts > maxAttempts) { clearInterval(poll); onFail('Timed out'); }
      return;
    }
    clearInterval(poll);
    if (s.status === 'done') onDone(s.result);
    else onFail(s.error || (s.status === 'unknown' ? 'Job not found (server restarted?)' : 'Failed'));
  }, 1500);
  return () => clearInterval(poll); // stop following (the job itself keeps running)
}

// start a job and wait for it (rejects with the backend's reason)
export async function runJob(route: string, body: unknown, onProgress: (s: JobStatus) => void = () => {}, maxAttempts?: number): Promise<unknown> {
  const {jobId, error} = await fetch(route, {method: 'POST', body: JSON.stringify(body)}).then((r) => r.json());
  if (!jobId) throw new Error(error || `${route} did not start`);
  return new Promise((resolve, reject) => pollJob(route, jobId, onProgress, resolve, (m) => reject(new Error(m)), maxAttempts));
}
// what the job made (the MCP's jobResult): a backend that does not hand it back runs older code
export function made<T>(route: string, result: unknown): T {
  if (result == null) throw new Error(`${route} finished without its result — restart the backend (npm start)`);
  return result as T;
}
export const jobResult = async <T,>(route: string, body: unknown, onProgress?: (s: JobStatus) => void): Promise<T> => made<T>(route, await runJob(route, body, onProgress));

// a JSON the job wrote under public/, fresh
export const readPublic = <T,>(file: string): Promise<T> => fetch(`/${file}?_=${Date.now()}`).then((r) => r.json());
