import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fmtMB, isVideoFile, pct, uploadError} from '../editor/upload.ts';

test('uploadError: the server JSON error and detail are shown with the status', () => {
  assert.equal(uploadError(500, 'Internal Server Error', JSON.stringify({error: 'transcode failed', detail: 'moov atom not found'})),
    '500 Internal Server Error — transcode failed: moov atom not found');
  assert.equal(uploadError(500, '', JSON.stringify({error: 'transcode failed', detail: 'libpostproc 57. 3.100\nError opening input files: Invalid data found when processing input\n'})),
    '500 — transcode failed: Error opening input files: Invalid data found when processing input');
  assert.equal(uploadError(403, '', JSON.stringify({error: 'path ingest needs the backend token'})), '403 — path ingest needs the backend token');
});

test('uploadError: non-JSON bodies, auth, size and network failures still say something', () => {
  assert.equal(uploadError(502, 'Bad Gateway', '<html><body><h1>502 Bad Gateway</h1></body></html>'), '502 Bad Gateway — 502 Bad Gateway');
  assert.equal(uploadError(401, 'Unauthorized', ''), '401 Unauthorized — not signed in');
  assert.equal(uploadError(413, '', ''), '413 — file too large');
  assert.match(uploadError(0, '', ''), /Network error/);
});

test('progress helpers', () => {
  assert.equal(pct(0, 0), 0);
  assert.equal(pct(512, 1024), 50);
  assert.equal(pct(2000, 1024), 100);
  assert.equal(fmtMB(1.6 * 1048576), '1.6 MB');
  assert.equal(fmtMB(250 * 1048576), '250 MB');
  assert.ok(isVideoFile({name: 'a.MOV', type: ''}));
  assert.ok(isVideoFile({name: 'x', type: 'video/mp4'}));
  assert.ok(!isVideoFile({name: 'notes.txt', type: 'text/plain'}));
});
