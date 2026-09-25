# reel — the reel-agent CLI for agents

`reel` operates reel-agent from a shell on the box that runs its backend (you are
there over SSH). It talks only to the backend's HTTP API — it never reads the
server's config, `.env`, `public/` or other users' folders. Its main user is an
agent: every command takes `--json`, nothing prompts, and `reel help --json`
describes every command, flag, output and exit code.

## Setup

- `REEL_URL` — the backend (default `http://127.0.0.1:3333`).
- Your token: `~/.config/reel/token`, mode 0600 (`reel` refuses a file others can
  read), or `REEL_TOKEN`. `reel` never prints it.
- `reel doctor` checks the connection, the token, free disk and memory, and the
  render queue, and says how to fix what fails.

## The flow

```bash
reel projects create "Promo café" --json            # → {id: "promo-cafe", created}
reel clips add promo-cafe ~/shoot/ --json            # a folder or files, appended to the timeline
reel captions generate promo-cafe --json             # transcribe + page the speech
reel captions get promo-cafe --json > caps.json      # edit the pages (text, tiers, timing)
reel captions diff promo-cafe caps.json --json       # what would change
reel captions set promo-cafe caps.json --json
reel captions validate promo-cafe --json             # exit 9 when there are errors
reel render start promo-cafe --json                  # → {jobId, plan}; returns at once
reel render wait <jobId> --timeout 1200 --json       # exit 0 done, 8 failed, 124 timeout
reel render download <jobId> --out promo.mp4 --json
reel review-link promo-cafe --json                   # → {url}: a private page for the client
```

Drafts (`render start --draft`) are half size and never become review versions;
a review link needs a final that passed QC.

## The contract

- `--json`: one JSON document on stdout. Errors too: `{error, code, hint, …}` with
  a non-zero exit code — 2 usage, 3 token, 4 not found, 5 conflict / busy, 6 disk
  or memory, 7 backend unreachable, 8 render failed, 9 validation errors, 124
  timeout. Without `--json`: text on stdout, errors on stderr.
- Safe to retry: `projects create` returns the project it made; `clips add` skips
  a file already added (name + size + mtime); `captions set` of the same pages
  changes nothing; `render start` of the same render returns the same job;
  `render download` resumes a partial file and skips a complete one. Every call
  to `review-link` makes a new link (`--list`, `--revoke <id>`).
- Long work returns an id at once: `render start` → `render status` /
  `render wait --timeout`. A timeout leaves the render running.
- Project writes go through the backend's compare-and-swap: when the editor or
  another agent saved in between, `reel` reads again and redoes its change.

## Renders and the layer cache

`render start` runs in `layers` mode by default: the reel without captions (the
master) is cached, and a captions-only change re-renders just the caption layer.
It tells you before it runs whether the render will be complete and why
(`plan.full`, `plan.reasons`): mode full, captions that reach into the footage
(focus pull, hero punch, glass pages, captions behind the presenter), B-roll to
download, or no cached master because something besides the captions changed.
`reel render start <p> --plan --json` asks without queueing anything.

One render at a time per user: a second, different one is refused with
`render_busy` (exit 5) and the id of the one running — wait for it or
`reel render cancel` it. Renders are refused (exit 6) while free disk or memory
is under the backend's floors, instead of taking the box down.

## Clips

`clips add` hands the backend the path when it may read it for you — your own
file, or one anyone can read — and otherwise uploads it in 8 MB chunks that
resume after a dropped connection (files of hundreds of MB are fine). `--upload`
always uploads.

## Admins

A token is made by an admin — the backend token (`REEL_BACKEND_TOKEN`) or a user
token created with `--admin`:

```bash
reel token create ana --out /tmp/ana.token --json   # written 0600, never printed
sudo install -o ana -m 600 -D /tmp/ana.token ~ana/.config/reel/token && rm /tmp/ana.token
reel token list --json
reel token revoke ana --json                        # by user or token id
```

`token create` records the user's Unix uid (`id -u <user>`, or `--uid`) so the
backend may read that user's own files by path.

Install once on the server (Node 24 on every user's PATH; the checkout readable
by them): `sudo ln -sf "$PWD/cli/reel.mjs" /usr/local/bin/reel`. Backend
settings: `REEL_REQUIRE_TOKEN=1` makes loopback API calls carry a token (a box
shared over SSH; without it a caller with no token is still let in, as the local
editor and the MCP are — they send no token yet, so they stop working with it on),
`REEL_RENDER_MIN_FREE_DISK_MB` (3072) and `REEL_RENDER_MIN_FREE_MEM_MB` (1024,
Linux) are the render floors (0 turns one off), `REEL_UPLOAD_MAX_MB` (2048),
`REEL_TOKENS_FILE` (`.reel-tokens.json`).
