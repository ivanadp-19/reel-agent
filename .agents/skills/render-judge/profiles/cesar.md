# Client profile: César (VIBEM)

César edits real-estate reels and tests reel-agent at night; he opens what we
delivered in the morning. `cesar.json` next to this file turns on his rule
checks in `judge.mjs` (it is picked automatically for the `vibem` caption
style or a VIBEM / César brand kit, or with `--profile cesar`). This page is
what the judge checks **with its eyes** for him, on top of `judge.md` and
`checks.md`. The generic judge stays generic; everything here is his.

## Deliverables and labels (his workflow)

- Every reel ships as a **clean master** (no captions) plus the **same edit
  with captions**. Render them back to back from the same edit
  (`set_captions off` → `render` → `set_captions on` → `render`), and judge
  the captioned one with `--role captioned --pair <clean master>`:
  `parity` fails if anything besides the captions differs (duration, cuts,
  audio).
- **EXTRA versions** (another hook, another length, an alternate take) live in
  their own project — `duplicate_project` named `"<reel> — EXTRA n (<what
  changes>)"` — and are delivered apart, labeled EXTRA. Never re-render the
  master's project with extra changes (`version` check, `--role extra`).
- The base master is delivered **right away**, labeled; the judge runs in
  parallel and its report goes next to the delivery. Labels: `QC técnico en
  curso` → `QC técnico superado` or `QC técnico: n hallazgos`. **Never
  "aprobado"**: only César approves.

## Captions (VIBEM look)

His look is the G1 reel **v11** he approved, measured frame by frame. Where his
older written notes say otherwise (yellow at the same size, a block that
recenters, a 250 ms hold, a 45 ms cascade), the v11 video wins (user decision
2026-09-26). The `vibem` pack is v11; `vibemReference` is the same pack under
an old id.

| Rule | How the judge checks it |
|---|---|
| One page = one sentence at most | The shared pager ends every page at a sentence end (it used to keep "Carmen. Está" together in `vibem`). The rule `pagination` catches old or hand-made pages; the fix re-pages with `set_caption_style vibem` |
| Commas stay on screen mid-page, in the word's color, and never end a page (FARO DEL / MAYAB, ALTA); a page-final comma and every period go; a yellow figure stands alone (MONTEALBÁN \| 326); digits stay digits even when the guion spells them out (54) | Decided in the pager (`layout.keepCommas` / `figurePages`, src/paging.ts) and the guion reconciliation (src/guion.ts). His notes broke pages on commas: the v11 video wins (user decision 2026-09-26) |
| Each word slides up at its own spoken onset, already in its final place: the lines never recenter while a page builds | Decided in the preset (`upcoming: 'hidden'`, no cascade); `sync` measures the onsets |
| Yellow words: every figure and date (CINCO MINUTOS, 326, 54, AGOSTO 2027), place and name (PLAZA ALTABRISA, FARO DEL MAYAB, STAR MÉDICA), amenity and property noun (ROOFTOP, HOSPITALES, SÚPER, DEPARTAMENTOS), CERCA and the CTA (LLENA EL FORMULARIO): v11 marks 28 of 104 words. His G2 note kept "departamentos" white: the v11 video wins (user decision 2026-09-26) | judgment on the overview sheet. The captions step proposes them with the `vibem` rules (`highlight` in the preset: 30 proposed on G1, the 28 of v11 plus ALTA ESPECIALIDAD); the agent adjusts with `annotate_captions`. Tiers set by hand are never re-derived by a restyle or a re-run; moving to `vibem` from another pack re-proposes the words that pack only proposed. `tier1-density` warns above 35 % |
| Yellow (#FFE500) at **1.15×** the white words | Decided in the preset (tiers at 1.15, measured on v11: cap height 44–46 px against 38 at 576×1024). The rule `accent-size` (`accentScale` in `cesar.json`) only guards against a regression |
| Helvetica Bold, caps, white at 85 %, soft halo, no stroke, block top at 53 % | judgment on the overview sheet. The preset loads `public/fonts/Helvetica-Bold.ttf` (`npm run setup` extracts it on a Mac); a missing file, or another face saved under that name (an Arial), stops the render and `validate` reports `font-missing` / `font-wrong` (`npm run setup` checks the face too). Say so if the face on screen is not Helvetica (Arial's R has a straight leg) |
| A long word may run into the side margin at full size (DEPARTAMENTOS spans 93 % of the width in v11) | `overflow` counts only a word wider than the whole frame |
| No captions over silence: a page stays ~550 ms after its last word unless the next page comes first | judgment: frames inside a pause longer than ~0.6 s show no page |
| Glossary wins over the transcript: **skypool**, **solarium**, and each reel's place and project names | The brand kit's `glossary` (`set_brand glossary`, the Styles tab; the kit lives in `public/brands/`, never in git) is applied by the captions pipeline before paging: a two-word variant of a one-word term becomes one word. The rule `glossary` checks captions and graphics against this profile's list plus the kit's, and `split-name` flags a term split across pages |
| Names may split across lines and pages, as in v11 (MONTEALBÁN \| 326 on two pages, CITY / CENTER on two lines) | `namesMaySplit` in `cesar.json`: `split-name` only counts a split glossary term |

## Look

- Compare against the **approved G1 v2** and against **"Hechos por mí"** (his
  own reels): rule-side `color-ref` (luma, contrast, saturation, white
  balance medians), and your eyes on the `color-ref-*` sheets (references on
  top, the render below). The references live in `.refs/cesar/` (gitignored).
  If they are missing, the check is SKIPPED: say so, don't guess.
- He calls blown skin or walls "quemado", and that is a major once you
  confirm it on the frame. A bright sky or window is **not** "quemado": that
  candidate is noise unless a face or the interior is clipped.

## Sound

- A camera read, a countdown ("tres, dos, uno"), "listo", "acción" and crew
  chatter are **not off-mic**. The rules classify them as `crew-talk` (cut it,
  it is not a second voice) and `read-through` (the line read before the take).
  Only what is neither is `off-mic`.
- **G7**: the phone filter goes **only on the man's questions** (the
  interviewer, not the main speaker). `phone-filter` measures which sentences
  are band-limited (300–3400 Hz) and compares them with that rule. reel-agent
  has no phone-filter tool, so a violation is escalated, not fixed by the agent.

## Coverage of the script (guion)

Every scene and insert the script names must be on screen. In **G1**, the
inserts for plazas, hospitales and universidades were missing, and so was the
street super. `insert-missing` reads the plan's `INSERTS:` block and the
known reels below, and a missing insert is a blocker. If the brief carries the
script, read it yourself too: the plan's list is a starting point, not the
truth. A scene the script names that neither list has is a blocker you add
(judgment).

The words themselves: with the script attached (`set_guion`), captions take the
script's wording where it aligns with the audio ("acomodan" → "acomoda a").
Where the audio and the script say different things (G2: "70 invitados" said,
60 written) **the audio wins** — his rule — and `validate-guion-conflict` goes to
him as an advisory with both quoted; it never fails the reel.

## Picture integrity and promises (G10 V2)

- **Black flashes.** His `blackdetect d=0.4` missed real blacks of 3–5 frames
  (G10 V2 at 7.51–7.61 s and 38.34–38.51 s). `black-flash` catches a single
  frame, in the master's own fps, and it is a blocker. `blackFades` in
  `cesar.json` is 0 at both ends. If a reel does fade to or from black, set the
  seconds there, not in the judge.
- **Frame 0 black.** 14 of 18 real masters opened on one solid black frame
  (the thumbnail). `frame0-black` measures frame 0 with `signalstats`, and a flat,
  dark frame is a blocker. The renderer fix is in another PR; this is the net.
- **A cut inside a B-roll** (the garage with a fast pan): `source-cut` is an
  advisory. It goes to him with the timestamp and the source time and never
  counts toward the verdict: not unconfirmed, not confirmed by the judge, and
  not as a pattern of minors. He decides.
- **VO promises** ("tope magnético", "acabado en roble"): the judge looks at the
  insert that plays while it is said. `claim-image` is a heuristic major with the
  quoted promise and the frame. It is never fixed automatically.

## Noise he asked us to stop failing on

Never auto-fail on these. They are candidates and count only if the frame
shows a real defect:

- a continuous take over 7 s (`static`, nit)
- a bright sky (`color-burnt`)
- B-roll tags that do not repeat the narration (`broll-fit`): judge the shot, not the words
- dramatic pauses: after a full stop, after "…" or ",", or right before the highlighted word (`pause` candidate). A pause mid-sentence with no reason is still a major, and dead air ≥ 2 s always is

## Known reels

| Reel | What to check |
|---|---|
| G1 | inserts: plazas comerciales, hospitales, universidades (B-roll), the street super (graphic) |
| G7 | phone filter only on the man's questions |
