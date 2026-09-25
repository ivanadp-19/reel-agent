// The WhisperX line of the setup checklist. With Deepgram active (DEEPGRAM_API_KEY,
// REEL_STT not pinned to whisperx — the rule of scripts/lib-transcribe.mjs useDeepgram)
// WhisperX is only the local fallback, so a missing .venv does not block (Railway has none).
export function whisperxCheck({venv, env = {}, device = 'cpu'}) {
  if (venv) return {id: 'whisperx', ok: true, label: `WhisperX (${device})`, hint: 'Run `npm run setup` to create .venv and install WhisperX — needed for captions, autocut, transcripts'};
  const deepgram = Boolean(env.DEEPGRAM_API_KEY) && (env.REEL_STT || 'auto') !== 'whisperx';
  if (deepgram) return {id: 'whisperx', ok: true, label: 'WhisperX (optional — Deepgram active)', hint: 'Deepgram handles transcription; WhisperX is only the local fallback (`npm run setup` installs it)', optional: true};
  return {id: 'whisperx', ok: false, label: 'WhisperX', hint: 'Run `npm run setup` to create .venv and install WhisperX — needed for captions, autocut, transcripts'};
}
