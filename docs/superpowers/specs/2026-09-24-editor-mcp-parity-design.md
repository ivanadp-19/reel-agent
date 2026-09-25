# Editor ↔ MCP parity

The MCP server (`mcp/server.mjs`, 55 tools) can do things the browser editor
(`editor/`) cannot. Everything the agent can set on a project, a person should
be able to set — and see — in the editor, with the same shared code deciding
the milliseconds. This spec maps the gap and designs the missing UI.

## Gap map

Already at parity (nothing to do): `list_projects`, `get_project`, `rename_project`,
`add_clips`, `reorder_clips`, `trim_clip`, `set_clip`, `delete_clips`, `split_clip`,
`set_keyframes`, `edit_caption` (text, accent, position, size), `annotate_captions`
(tier, emoji), `set_caption_style`, `set_accent_color` (swatches), `add_broll_assets`
(upload), `edit_broll` (mode, scale, swap), `delete_brolls`, `set_music` (upload,
volume, fade, duck), `set_language`, `set_off_mic`, `run_ai_step`, `render`, `health`.

Missing in the editor, grouped by what they need:

| Group | Tools | Needs |
|---|---|---|
| A · pure project edits | `set_transitions`, `set_audio_cut`, `set_speed_ramp`, `set_audio`, `add_caption`, `delete_captions`, `edit_caption behind`, `edit_broll arrive/leave/timing`, `add_broll` (own footage), `add_graphic`, `edit_graphic`, `delete_graphics`, `set_brand`, `set_grade`, `prepare_mattes`, `validate`, `set_plan`, `duplicate_project`, free-hex accent, QC text after export | shared `src/` code + jobs the backend already has (`/api/grade`, `/api/matte`); two tiny routes for brand kits and image upload |
| B · transcript | `get_transcript`, `find_cut_candidates`, `cut_words` | the existing `/api/transcribe` job; the word-cut snapping moves from `mcp/server.mjs` into `src/cuts.ts` so both callers share it |
| C · sourcing | `search_stock`, `add_broll` (stock), `search_music`, `set_music music_id`, `search_asset`, `list_assets`, `generate_asset`, `broll_library`, `tag_broll_asset`, `suggest_broll` | backend routes wrapping `mcp/assets.mjs`, `mcp/music.mjs`, `mcp/broll.mjs` and the Pexels client (moved out of the MCP server) |

Not ported, on purpose: `caption_proof`, `motion_proof`, `frame_at` (the editor
has a live player), `qc` as a separate action (the final render already runs
the gate; the editor shows its text).

## Principles

- One implementation per rule. Logic that lives only in `mcp/server.mjs` and
  the editor needs (word-cut snapping, off-mic / cut-word issues, Pexels) moves
  to `src/` or a `mcp/*.mjs` module; the MCP tool becomes a thin wrapper.
- The editor writes the same project JSON fields the MCP writes. Autosave sends
  every field (it now includes `plan`), the backend merge keeps the rest.
- Undo covers graphics too (snapshot = clips, music, captions, brolls, graphics).
  Brand, grade, audio, plan stay outside undo, like accent and style today.
- Same design system (the existing tokens and Material Symbols); no new
  dependencies.

## Editor design

### Inspector (right panel, widened to `w-96`)

Tabs: **Clip · Captions · B-roll · Graphics · Styles · Settings**.

**Clip** — the selected clip card moves here from Captions. It gains:
- *Enters with*: `<select>` over `ENTERS` plus *pack* (resolves to
  `PACKS[captionStyle].transition`); *cut* deletes `enter`.
- *J-cut / L-cut*: two number inputs 0–4 s (0 clears), writing `jSec` / `lSec`.
- *Speed ramp*: from × to × steps (2–6) → button. Uses `speedRamp` +
  `splitClip` exactly like the MCP (pieces get the eased speeds, B-roll re-anchored).
- Project-wide row: *Punch alternate* (`punchAlternate`) and *Clear transitions*.
- Empty state when nothing is selected.

**Captions** — generate button, page list (as today) plus:
- *Add page at playhead*: prompt for text; the page lands on the clip under the
  playhead (`locate`), 2 s, `topPct` from the nearest page on that source or 58.
- Per selected page: *Behind the presenter* toggle (`behind`), *Delete page*
  (its `wid`s go to `hiddenWids`, like `delete_captions`).

**B-roll** — cue list (as today) plus per cue *arrive* / *leave* selects and
start / duration inputs (timeline seconds, `edit_broll` semantics: the cue
stays on one clip). *Add at playhead*: pick one of the project's own assets
(`brollAssets` ∪ the machine library at `/broll-assets/library.json`), mode,
duration. Group C adds stock search and suggestions here.

**Graphics** — new tab. List of projected graphics (template, time, props
summary); click selects and seeks. *Add*: template `<select>` (desc as title)
→ a form generated from the template's zod schema (`fieldsOf` next to
`describeSchema`: string → text, enum → select, boolean → checkbox, number →
number, array of objects → rows with add/remove) → *Add at playhead*
(`TEMPLATES[t].defaultMs`). Selected graphic: same form for props, start /
duration inputs, `yPct` slider, `behind`, *reveal / out / life / camera*
selects, *Delete*. Props are validated with `parseProps`; errors show inline.
A *Prepare mattes (N spans)* button appears when `spansWithoutMatte` finds any.

**Styles** — style-pack grid and accent swatches (as today) plus a free
`<input type="color">`, then:
- *Brand kit*: name, accent / dark / light colors, headline and caption font
  selects (`FONT_FAMILIES`), logo upload (`POST /api/upload-image`), *Load kit*
  (`GET /api/brands`), *Save as kit* (`POST /api/brands/:slug`), *Clear*.
  `accentColor` follows the brand accent, like `set_accent_color`.
- *Color*: look select (`LOOKS`), intensity slider, *auto correction* toggle;
  *Analyze* runs `/api/grade` and stores `bySrc` from `/grade.json`.

**Settings** — music (as today, plus the credit line when there is one), then:
- *Audio*: voice cleanup select (`CLEAN` keys with their desc), sound effects toggle.
- *Plan*: textarea bound to `plan` (what the agent wrote with `set_plan`; editable).
- *Validate*: button → issue list from `validateProject` (faces from
  `/clips/faces/<source>.json`) + the transcript checks (off-mic words left,
  cuts inside a word) from `/transcript.json` when it exists.
- Project info rows (as today).

### Left panel: Assets | Transcript (group B)

A two-tab strip at the top of the left sidebar. **Transcript** shows every
clip in timeline order with its words as chips (`i:word` id on hover), pauses
as `·0.8s`, off-mic runs dimmed with a mic-off mark, speaker changes as `spk2`
tags. Click seeks; click then shift-click selects a range on one clip; *Cut*
removes it with the shared word-cut planner (snaps into the pauses, drops dead
pieces). *Suggest cuts* runs `findCutCandidates` and lists the candidates with
checkboxes (kind, text, kept take) → *Cut selected* applies them in one undo
step, like `cut_words ranges`. The panel (re)runs `/api/transcribe` when it
opens and after a cut (cached per source, so seconds).

### Start screen

*Duplicate* on a project card: `GET` the project, `POST` it under `p-<ts>`
with "(copy)" appended.

### Export

The render result's `qc` text shows under the download link.

## Shared code moves

- `src/cuts.ts`: `planWordCuts(transcript, clips, ranges)` → source spans
  (the `SNAP_MS` snapping, merged overlaps) and `applyWordCuts(clips, brolls,
  spans, transcript)` → `{clips, brolls, lines}` (cutRange + reanchor + drop
  silent pieces < 4 s with no word). `cut_words` in the MCP calls them.
- `src/validate.ts`: `transcriptIssues(p, transcript)` = today's
  `offMicIssues` + `cutWordIssues`. `validate` / `caption_proof` call it.
- `mcp/stock.mjs`: the Pexels client (`searchStock`), used by the MCP tool and
  by `GET /api/stock` (group C).
- `src/graphicTemplates.ts`: `fieldsOf(schema)` for the form generator.

## Backend routes

Group A: `GET /api/brands`, `GET|POST /api/brands/:slug`, `POST /api/upload-image?name=`
(→ `public/brand/`). Group C: `GET /api/stock?q&kind`, `GET /api/music/search?q`,
`POST /api/music/pick` (downloads, returns `{src, credit}`), `GET /api/assets?q&kind`,
`GET /api/assets/search?q&kind&style`, `POST /api/assets/generate`,
`GET /api/broll-library`, `POST /api/broll-library/:id` (tags, desc),
`GET /api/black?src`. All local, same origin, no new auth.

## Testing

- `node --test`: unit tests for `planWordCuts` / `applyWordCuts` (snap, merge,
  dead-piece drop, a range across two clips is rejected), `fieldsOf` on every
  template schema, `transcriptIssues`.
- `npm run typecheck` covers `editor/`.
- Manual: each tab exercised in the browser preview; MCP `get_project`
  reads back what the editor wrote.

## Order

A (this PR) → B → C, each on top of the previous branch.
