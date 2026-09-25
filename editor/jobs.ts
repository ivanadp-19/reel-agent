// Background jobs on the backend (captions, autocut, transcribe, grade, matte):
// POST starts one, GET <route>/<id> reports it. Dead-job (server restart) and
// timeout guards; network hiccups tolerated for a few polls.
export type JobStatus = {status?: string; label?: string; progress?: number; error?: string; etaSec?: number | null};

export function pollJob(
  base: string,
  jobId: string,
  onProgress: (s: JobStatus) => void,
  onDone: () => void,
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
    if (s.status === 'done') onDone();
    else onFail(s.error || (s.status === 'unknown' ? 'Job not found (server restarted?)' : 'Failed'));
  }, 1500);
  return () => clearInterval(poll); // stop following (the job itself keeps running)
}

// start a job and wait for it (rejects with the backend's reason)
export async function runJob(route: string, body: unknown, onProgress: (s: JobStatus) => void = () => {}, maxAttempts?: number): Promise<void> {
  const {jobId, error} = await fetch(route, {method: 'POST', body: JSON.stringify(body)}).then((r) => r.json());
  if (!jobId) throw new Error(error || `${route} did not start`);
  await new Promise<void>((resolve, reject) => pollJob(route, jobId, onProgress, resolve, (m) => reject(new Error(m)), maxAttempts));
}

// a JSON the job wrote under public/, fresh
export const readPublic = <T,>(file: string): Promise<T> => fetch(`/${file}?_=${Date.now()}`).then((r) => r.json());
