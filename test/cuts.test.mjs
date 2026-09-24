import {test} from 'node:test';
import assert from 'node:assert/strict';
import {findCutCandidates, similar} from '../src/cuts.ts';

// words from a phrase list: [text, off?]; 250 ms per word, pauseMs between phrases
function clip(phrases, pauseMs = 900) {
  const words = [];
  let t = 0, i = 0;
  for (const [p, off] of phrases) {
    for (const w of p.split(' ')) { words.push({i: i++, word: w, startMs: t, endMs: t + 250, ...(off ? {off: true} : {})}); t += 300; }
    t += pauseMs;
  }
  return {clipId: 'c', source: 'S', words};
}
const brief = (cs) => cs.map((c) => `${c.kind} ${c.text}${c.note ? ` (${c.note})` : ''}`);

test('similar: repeats and false starts, not shared short phrases', () => {
  const t = (s) => s.toLowerCase().split(' ');
  assert.ok(similar(t('they told us that debt is bad'), t('they told us debt is bad')));
  assert.ok(similar(t('debt is actually one of the what'), t('debt is actually one of the biggest creators in this country')));
  assert.ok(!similar(t('good debt'), t('that is considered good debt')));
});

test('retakes keep the last complete take; the off-mic line and the false start go', () => {
  const c = clip([['Our parents, the media and even Dave Ramsey.', true], ['Our parents, the media and even Dave Ramsey.'], ['Debt is actually one of the, what?'], ['Debt is actually one of the biggest creators in this country.']]);
  assert.deepEqual(brief(findCutCandidates([c])), [
    'retake Our parents, the media and even Dave Ramsey. (off-mic voice)',
    'retake Debt is actually one of the, what? (false start)',
  ]);
});

test('meta talk and fillers', () => {
  const c = clip([['So um debt is, you know, powerful.'], ['Debt is, oh my god, say it again. Sorry.']]);
  assert.deepEqual(brief(findCutCandidates([c])), ['filler um', 'filler you know,', 'meta Debt is, oh my god, say it again.', 'meta Sorry.']);
});

test('Spanish: eh, o sea, and "este" only between pauses', () => {
  const words = [['Eh', 0, 200], ['la', 700, 900], ['casa', 950, 1300], ['este', 1600, 1900], ['tiene', 2200, 2500], ['o', 2550, 2650], ['sea', 2700, 2900], ['este', 2950, 3200], ['jardín.', 3250, 3700]].map(([word, startMs, endMs], i) => ({i, word, startMs, endMs}));
  assert.deepEqual(brief(findCutCandidates([{clipId: 'c', source: 'S', words}])), ['filler Eh', 'filler este (between pauses)', 'filler o sea']);
});
