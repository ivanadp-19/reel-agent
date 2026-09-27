# Client profile: example

A client's profile is two files on the volume, never in git (this repository
is public): `public/clients/<client>/profile.json` turns on and tunes the rule
checks in `judge.mjs`, and `profile.md` next to it (a page like this one) holds
what the judge checks **with its eyes** for that client, on top of `judge.md`
and `checks.md`. Its `colorRefs` paths are relative to that folder
(`refs/approved.mp4` = `public/clients/<client>/refs/approved.mp4`). The keys
are listed at the end of `checks.md`.

`judge.mjs` picks a profile by `--profile <id>`, by the brand kit's
`style.judgeProfile`, or by the profile's `match` (caption style ids, brand
name). A profile that is named but not on this machine stops the judge and says
where it looked; copy the client's folder to this machine's `public/clients/`.
This example matches nothing, so it is only picked by name
(`--profile example`).

## Deliverables and labels

- Say what the client receives: one final, or a clean master plus a captioned
  version rendered from one edit (`--role captioned --pair <clean master>`),
  and how extras are delivered.
- Labels: `QC técnico en curso` → `QC técnico superado` or `QC técnico: n
  hallazgos`. Never "aprobado": only the client approves.

## Captions

| Rule | How the judge checks it |
|---|---|
| One page = one sentence at most | `captions.pagination: "sentence"` in the JSON |
| Key words at 1.15× the plain words | `captions.accentScale`; the look itself lives in the caption pack |

## Look

- Compare against the client's approved references (`colorRefs`). If they are
  missing, the check is SKIPPED: say so, don't guess.

## Known reels

| Reel | What to check |
|---|---|
| R1 | the pool insert (B-roll) |
