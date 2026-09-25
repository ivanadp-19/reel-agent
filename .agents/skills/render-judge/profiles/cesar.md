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

| Rule | How the judge checks it |
|---|---|
| One page = one sentence at most | The shared pager ends every page at a sentence end (it used to keep "Carmen. Está" together in `vibem`). The rule `pagination` catches old or hand-made pages; the fix re-pages with `set_caption_style vibem` |
| Words enter in a **45 ms cascade** | judgment: `motion_proof` at the start of 2–3 pages. At 30 fps, 45 ms is 1–2 frames between one word's arrival and the next. Words that appear together, or at the pace of speech with no cascade, are a major. No preset parameter declares this, so no rule can measure it |
| Yellow (#FFE500) at the **same size** as white | Decided in the preset: `vibem` tiers are at scale 1.0, no longer 1.15. The rule `accent-size` only guards against a regression |
| Helvetica Bold, caps, white at 85 %, soft halo, no stroke | judgment on the overview sheet. The preset uses the file `public/fonts/Helvetica-Bold.ttf`; a Liberation Sans stand-in is not his font. Say so if the face on screen is not Helvetica |
| No captions over silence (a page ends ~250 ms after its last word) | judgment: frames inside pauses show no page |
| Glossary wins over the transcript: **skypool**, **solarium** | rule `glossary` on captions and graphics ("sky pool", "skypul" → "skypool"), and `split-name` when a term is split across pages |
| Compound names never split across pages or lines | `split-name` rule for glossary terms and highlight spans. A capitalized pair is only a **candidate**: capitals are a bad signal for compounds, so look at the real frame at the page change before you count it |

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
