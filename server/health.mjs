import {useDeepgram} from '../scripts/transcript-cache.mjs';

// The WhisperX line of the setup checklist. With Deepgram active (DEEPGRAM_API_KEY,
// REEL_STT not pinned to whisperx — scripts/transcript-cache.mjs useDeepgram)
// WhisperX is only the local fallback, so a missing .venv does not block (Railway has none):
// ok false + optional, like the other optional checks, so the checklist shows it as info.
export function whisperxCheck({venv, env = {}, device = 'cpu'}) {
  if (venv) return {id: 'whisperx', ok: true, label: `WhisperX (${device})`, hint: 'Run `npm run setup` to create .venv and install WhisperX — needed for captions, autocut, transcripts'};
  if (useDeepgram(env)) return {id: 'whisperx', ok: false, label: 'WhisperX (optional — Deepgram active)', hint: 'Deepgram handles transcription; WhisperX is only the local fallback (`npm run setup` installs it)', optional: true};
  return {id: 'whisperx', ok: false, label: 'WhisperX', hint: 'Run `npm run setup` to create .venv and install WhisperX — needed for captions, autocut, transcripts'};
}
