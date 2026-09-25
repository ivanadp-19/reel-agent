// Revision control for the caption pages of a project (GET / PUT /api/projects/<id>/captions,
// `reel captions get | set --expected-revision`): the revision is a hash of the captions array
// itself, so any writer that changed the pages — the editor, an agent, another `reel` — moves
// it, and a save of anything else (clips, music, the plan) does not.
import crypto from 'node:crypto';

export const captionsRevision = (captions) => crypto.createHash('sha256').update(JSON.stringify(captions ?? [])).digest('hex').slice(0, 16);

// Replace the pages of `prev` (the project as stored) → {status, body, next?}; `next` is the
// project to write, absent when nothing changes. A stale expectedRevision is a 409 and
// writes nothing; the same pages again change nothing (changed: false), whatever the revision.
export function replaceCaptions(prev, {captions, expectedRevision} = {}, now = new Date().toISOString()) {
  if (!Array.isArray(captions) || captions.some((c) => !c || typeof c !== 'object' || Array.isArray(c))) return {status: 400, body: {error: 'captions: an array of pages', code: 'bad_request'}};
  if (expectedRevision != null && typeof expectedRevision !== 'string') return {status: 400, body: {error: 'expectedRevision: a string', code: 'bad_request'}};
  const revision = captionsRevision(prev.captions);
  const next = captionsRevision(captions);
  // already these pages: a retry whose first answer was lost is not a conflict
  if (next === revision) return {status: 200, body: {changed: false, revision, updatedAt: prev.updatedAt ?? null}};
  if (expectedRevision != null && expectedRevision !== revision) {
    return {status: 409, body: {error: `the captions changed since revision ${expectedRevision} (now ${revision})`, code: 'revision_mismatch', revision, hint: 'read them again (reel captions get), redo your change, set with the new revision'}};
  }
  return {status: 200, body: {changed: true, revision: next, updatedAt: now}, next: {...prev, captions, updatedAt: now}};
}
