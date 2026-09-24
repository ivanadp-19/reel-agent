# Who is talking: speaker turns of a 16 kHz mono WAV with pyannote (speaker-diarization-3.1, gated:
# HF_TOKEN in .env and the model terms accepted on huggingface.co). Runs on MPS / CUDA / CPU.
#   .venv/bin/python scripts/diarize.py <in.16k.wav> <out.json>
# Output: {"speakers": ["SPEAKER_00", ...], "turns": [[startSec, endSec, "SPEAKER_00"], ...]}
# The audio is read with the stdlib (pyannote 4 reaches for torchcodec, which cannot find ffmpeg 8's
# libraries on macOS); the pipeline gets a waveform tensor instead of a path.
import os, sys, json, wave
import numpy as np
import torch
from pyannote.audio import Pipeline

src, out = sys.argv[1], sys.argv[2]
tok = os.environ.get('HF_TOKEN', '')
if not tok:
    print('HF_TOKEN not set', file=sys.stderr); sys.exit(2)
with wave.open(src, 'rb') as w:
    sr, ch, sw, n = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
    raw = w.readframes(n)
if sr != 16000 or ch != 1 or sw != 2:
    print(f'expected 16 kHz mono 16-bit, got {sr} Hz {ch} ch {sw} B', file=sys.stderr); sys.exit(2)
waveform = torch.from_numpy(np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0).unsqueeze(0)
pipe = Pipeline.from_pretrained('pyannote/speaker-diarization-3.1', token=tok)
for dev in (['cuda'] if torch.cuda.is_available() else []) + (['mps'] if torch.backends.mps.is_available() else []) + ['cpu']:
    try:
        pipe.to(torch.device(dev)); break
    except Exception:
        continue
result = pipe({'waveform': waveform, 'sample_rate': sr})
ann = getattr(result, 'speaker_diarization', result)
turns = [[round(s.start, 3), round(s.end, 3), spk] for s, _, spk in ann.itertracks(yield_label=True)]
json.dump({'speakers': sorted({t[2] for t in turns}), 'turns': turns}, open(out, 'w'))
print(f'{len(turns)} turns, {len({t[2] for t in turns})} speakers, {dev}')
