// A source's transcript caches (public/clips/transcripts/) and how they are read — with no side effect at
// import: no .env loaded, nothing read from the cwd. scripts/lib-transcribe.mjs writes the caches and reads
// them through this (with process.env, which it fills from the .env of the script's run); the backend and the
// MCP import it in-process (mcp/checks.mjs projectWords) and pass the env of THEIR ROOT's .env.
import fs from 'node:fs';
import path from 'node:path';
import {DROP_DB, assignSpeakers, flagOffMicBySpeaker} from '../src/speech.ts';

// Word times are relative to the SOURCE file, so the cache is keyed by source
// (+ language): autocut segments and re-arranged copies never re-transcribe.
export const sourceKey = (clip) => path.basename(clip.src).replace(/\.[^.]+$/, '');

// ---- Deepgram Nova-3 (optional, pre-recorded API) ----
// DEEPGRAM_API_KEY in .env switches transcription to Deepgram: seconds per clip
// instead of minutes on CPU WhisperX. Words land in the SAME cache format
// ({word, startMs, endMs}), so every downstream step is untouched. A failure
// (no network, bad key, quota) fails the job with Deepgram's error: WhisperX word
// times never stand in unannounced. REEL_STT=whisperx forces the local engine.
export const useDeepgram = (env = process.env) => Boolean(env.DEEPGRAM_API_KEY) && (env.REEL_STT || 'auto') !== 'whisperx';

// ... and by engine: with a Deepgram key a WhisperX transcript is never served from the cache (its
// misaligned times would stick for good), nor the other way round. WhisperX keeps the original
// name, so existing caches stay valid; the .spk / .loud sidecars are per source, shared by both.
// A source that has both says, per word, which word of the other one it is (`was`, lib-transcribe).
export const cacheName = (key, lang, dg = useDeepgram()) => `${key}.${lang}${dg ? '.dg' : ''}.json`;

// Speaker sidecar per source (who is talking): pyannote, only when HF_TOKEN is set (the model is gated).
// REEL_DIARIZE=0 turns it off.
export const diarizeOn = (env = process.env) => Boolean(env.HF_TOKEN) && env.REEL_DIARIZE !== '0';

// who says each word (the diarizer's turns) and which are the quiet voice off the mic (the loudness track)
export function voices(words, turns, loud, env = process.env) {
  if (turns) words = assignSpeakers(words, turns);
  return loud ? flagOffMicBySpeaker(words, loud, +(env.REEL_OFFMIC_DB || DROP_DB)) : words;
}

// A project's words from the per-source caches only: the files transcribeClip reads (this engine's cache,
// else the other engine's) with the speaker and loudness sidecars already written — it never transcribes,
// diarizes or decodes. The shape of public/transcript.json (scripts/transcribe.mjs): per clip, the words of
// its trim window; a source not transcribed yet has none (and `missing: true`: the judge tells no words from
// silence). The project checks read this (mcp/checks.mjs, the render judge),
// never public/transcript.json, which is the last run of ANY project on the machine. `env` decides the
// engine as the backend's jobs do: the caller's ROOT .env with its process env.
export function projectTranscript(p, publicDir, env) {
  const dir = path.join(publicDir, 'clips', 'transcripts');
  const read = (name) => { try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return null; } };
  const lang = p.lang ?? 'auto', dg = useDeepgram(env);
  return p.clips.map((clip) => {
    const key = sourceKey(clip);
    const cached = read(cacheName(key, lang, dg)) ?? read(cacheName(key, lang, !dg));
    const words = Array.isArray(cached) ? voices(cached, diarizeOn(env) ? read(`${key}.spk.json`)?.turns : null, p.offMic === 'off' ? null : read(`${key}.loud.json`), env) : [];
    const inMs = clip.inSec * 1000, outMs = clip.outSec * 1000;
    return {clipId: clip.id, source: key, words: words.map((w, i) => ({i, ...w})).filter((w) => w.endMs > inMs && w.startMs < outMs), ...(Array.isArray(cached) ? {} : {missing: true})};
  });
}
