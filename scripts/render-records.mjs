// What an export is and which project it belongs to: a small JSON next to
// every settled render (public/exports/<file>.mp4.json). The backend writes it
// when a render ends; scripts/cleanup-exports.mjs reads it to know the latest
// good final of each project (never purged) and which files are drafts or QC
// failures (purged after their TTL). A render without a record is
// "unattributed" and the cleanup never deletes it if it is a final.
import fs from 'node:fs';

// edited-<Date.now()><3 random bytes> (scripts/render-jobs.mjs newJobId; 2 in older renders)[-draft|-qcfail].mp4 — the only names the backend gives an export
export const EXPORT_NAME = /^edited-(\d{13}[0-9a-f]{0,6})(-draft|-qcfail)?\.mp4$/;
export const recordPath = (mp4) => `${mp4}.json`;

// kind: 'final' (passed QC) | 'draft' | 'qcfail'
export function writeRenderRecord(mp4, {projectId, kind, renderSec, now = new Date()}) {
  const rec = {projectId: typeof projectId === 'string' && /^[\w-]+$/.test(projectId) ? projectId : null, kind, createdAt: now.toISOString(), ...(renderSec != null ? {renderSec} : {})};
  fs.writeFileSync(recordPath(mp4), JSON.stringify(rec) + '\n');
  return rec;
}

// → the record, or null when there is none or it is unreadable
export function readRenderRecord(mp4) {
  try {
    const r = JSON.parse(fs.readFileSync(recordPath(mp4), 'utf8'));
    return r && typeof r === 'object' ? r : null;
  } catch { return null; }
}
