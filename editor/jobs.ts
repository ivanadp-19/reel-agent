// Background jobs on the backend (captions, autocut, transcribe, grade, matte):
// POST starts one, GET <route>/<id> reports it. Dead-job (server restart) and
// timeout guards; network hiccups tolerated for a few polls.
// result: the job's own output, handed back by the backend (never a file of public/ another job may have written since)
export type JobStatus = {status?: string; label?: string; progress?: number; error?: string; etaSec?: number | null; result?: unknown};

export function pollJob(
  base: string,
  jobId: string,
  onProgress: (s: JobStatus) => void,
  onDone: (s: JobStatus) => void,
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
    if (s.status === 'done') onDone(s);
    else onFail(s.error || (s.status === 'unknown' ? 'Job not found (server restarted?)' : 'Failed'));
  }, 1500);
  return () => clearInterval(poll); // stop following (the job itself keeps running)
}

// start a job and wait for it → its result (rejects with the backend's reason)
export async function runJob<T = unknown>(route: string, body: unknown, onProgress: (s: JobStatus) => void = () => {}, maxAttempts?: number): Promise<T> {
  const {jobId, error} = await fetch(route, {method: 'POST', body: JSON.stringify(body)}).then((r) => r.json());
  if (!jobId) throw new Error(error || `${route} did not start`);
  const s = await new Promise<JobStatus>((resolve, reject) => pollJob(route, jobId, onProgress, resolve, (m) => reject(new Error(m)), maxAttempts));
  if (s.result === undefined) throw new Error(`${route} finished without its result — restart the backend`);
  return s.result as T;
}
