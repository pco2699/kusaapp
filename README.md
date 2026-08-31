# Kusa — self-hosted habit tracker

A minimal habit tracker that runs as a **single Node.js file** (zero npm dependencies, uses the built-in `node:sqlite`).

![screenshot](docs/screenshot.png)

## Features

- 📱 **Mobile-first UI** — card layout with big tappable cells
- 🎨 **Streak heatmap** — cells darken as consecutive days stack up (1 day = 40% → 5+ days = full color)
- ✂️ **Skip** — long-press (mobile) / right-click (desktop) to skip a day with a diagonal slash; the streak bridges over skipped days
- 📆 **Any-of-weekday habits** — e.g. "run on any weekday", "gym on either weekend day". Non-target days are shown faded and rejected by the API. The streak counts *periods* (one per maximal run of allowed weekdays), not calendar days.
- 🗓 **All-of-weekday habits** — e.g. "weekdays only": every selected day counts, non-selected days are auto-skipped (the streak bridges over them automatically).
- 📊 Streak badges (current / best / total) per habit + daily progress ring
- 📶 **PWA + offline** — installable (manifest + service worker), reads from cache when offline, and queues check-ins/skips in `localStorage` to flush when back online
- 🌓 **Dark / light theme** — toggle in the header (🌙/☀️), follows the system preference by default, persisted per device (`?theme=dark|light` also works)
- 🖥️ **Responsive** — 7-day grid on phones, up to 45 days on wide screens (cells scale up)
- 🌱 Archiving (soft delete) — history is never lost
- ⚡ **Fast first paint** — the server inlines the initial state into the HTML, so the
  board renders on arrival instead of after a round trip to `/api/state`

## Requirements

- Node.js ≥ 22 (needs the built-in `node:sqlite`, stable since 22.5)

## Run

```bash
cp config.example.json config.json   # then edit port/token
node server.mjs
```

Open `http://127.0.0.1:8090/?key=<your-token>`.

> The key is stored in `localStorage` after the first visit, so the URL with `?key=` is only needed once. PWA assets (`sw.js`, `manifest.webmanifest`, icons) are served without auth; everything else requires the key (query param or `Authorization: Bearer`).
>
> Authenticating also sets a `kusa_key` cookie (`HttpOnly`, `SameSite=Strict`, 1 year). It authorizes **only** the `GET /` document, so later visits without `?key=` still get their state inlined into the page. Every API route continues to require the query param or the `Authorization` header — the cookie is never accepted for them, so it cannot be used for cross-site writes.

## Configuration

All settings live in `config.json` (copy from `config.example.json`):

| Key | Default | Description |
| --- | --- | --- |
| `port` | `8090` | TCP port to listen on |
| `token` | *(no default)* | Access key required by every authenticated request — set a long random string. Passed as `?key=…` or `Authorization: Bearer` |
| `lang` | `"ja"` | UI language: `"ja"` (Japanese) or `"en"` (English). Also sets the `<html lang>` and date formatting |
| `db` | `habits.db` *(next to `server.mjs`)* | Path to the SQLite file, resolved relative to the config file |

Set `KUSA_CONFIG` to run against a config file somewhere else — that is how one checkout
can serve several instances, and how the tests keep off your real database:

```bash
KUSA_CONFIG=/etc/kusa/work.json node server.mjs
```

`port: 0` asks the OS for a free port; the startup line reports the one it actually bound.

## Tests

No test framework, matching the rest of the project — `node:test` and `node:assert` ship
with Node:

```bash
node --test            # everything
node --test test/logic.test.mjs
```

- `test/logic.test.mjs` — the streak, period and "done today" math, driven through
  `getState(day)` so a test can ask about a specific weekday instead of waiting for one.
- `test/api.test.mjs` — boots the real server on a free port and exercises auth, the
  cookie rule, check-ins, skips, weekday enforcement, `days=` clipping, ETags and gzip.

Each test gets its own temp directory holding a `config.json` and the SQLite file it
names, so nothing touches your `habits.db`.

## API

- `GET /api/state` — full state: habits with days, skips, streak/longest/total
  - `?days=N` (optional) — clip each habit's `days`/`skips` to the last `N` days. Streaks
    and totals are still computed over the full history. Omit it for everything; the web
    UI passes `days=180`, which is all the grid can display.
- `POST /api/toggle` — `{ habit_id, date? }` toggle a check-in
- `POST /api/skip` — `{ habit_id, date? }` toggle a skip (streak bridges over)
- `POST /api/habits` — `{ op: "create", name, emoji?, any_days?: number[], all_days?: number[] }` or `{ op: "delete", id }`
  - `any_days`: array of weekday numbers (0=Sun … 6=Sat) — one hit on any of these days counts
  - `all_days`: array of weekday numbers — every selected day counts; non-selected days are auto-skipped
  - both omitted/null → daily habit

## Performance

The first page view is the thing this app is tuned for. What it does:

- **State inlined into the document** — `GET /` embeds the initial state, so the board
  paints without a follow-up `/api/state` request. What it embeds is clipped to the last
  180 days, so the document stays the same size after years of check-ins.
- **Brotli / gzip**, negotiated per request. Bodies are hashed and compressed once and
  reused; the static ones (`sw.js`, manifest) are compressed at max quality on startup.
- **ETags on everything**, so a repeat view revalidates into a `304` instead of
  redownloading. Icons are served `immutable` and cached in memory.
- **Cached state** — the computed state, its JSON and the inlined HTML are built once and
  invalidated on writes, keeping requests off SQLite and the streak math entirely.
- **Theme resolved in `<head>`** before the stylesheet, so a dark-mode load paints dark
  the first time rather than flashing white and repainting.
- **No `Intl` on the critical path** — building a formatter costs ~75ms on a throttled
  phone. Dates are formatted directly on both sides.
- Cells are built as one HTML string with delegated event handlers, streak heat comes
  from five CSS classes rather than a `color-mix()` per cell, and tooltips are composed
  on hover instead of up front.

Measured on the seeded two-year database (10 habits, ~6k check-ins), Chromium throttled
to 4× slower CPU on a 1.6 Mbps / 150 ms link:

| | before | after |
| --- | --- | --- |
| habit grid on screen | 2306 ms | 461 ms |
| transferred | 139 KB | 17 KB |
| requests before first paint | 3 | 1 |
| `GET /api/state` (p50) | 314 ms | 1.3 ms |

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push to `main` and
every pull request: parses `server.mjs` and the extension scripts, runs the test suite on
Node 22 and 24, and boots the server against an empty database to prove a first run still
creates its schema and answers `/api/health`. Nothing to install — there are no
dependencies to fetch.

## Deploy notes

- Listens on `127.0.0.1` only — put a reverse proxy (nginx/caddy) in front for TLS/remote access.
- `habits.db` (SQLite) is created next to `server.mjs` on first run, or wherever `db` points.
- Data lives in two tables: `habits` (with `any_days` JSON) and `checkins` (`date`, `skip`).
- Day boundaries come from a fixed timezone in `server.mjs` (`TZ_FMT`), not the host clock,
  so the box can sit in UTC without shifting what counts as "today". Set it to your timezone.

### Behind a domain

[`deploy/`](deploy/) has the two files that turn a checkout into a running site:

1. `deploy/habit-tracker.service` — a systemd **user** unit. Point `ExecStart` at your node
   binary and checkout, install it under `~/.config/systemd/user/`, then
   `systemctl --user enable --now habit-tracker`. Run `sudo loginctl enable-linger "$USER"`
   so it keeps running when you are not logged in.
2. `deploy/nginx.conf.example` — a vhost proxying your domain to `127.0.0.1:8090`. Enable it,
   reload nginx, then `sudo certbot --nginx -d <your-domain> --redirect` for TLS.

### Continuous deployment

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) ships `main` to your box on
every push: it runs CI first, rsyncs the checkout over SSH, restarts the systemd unit, and
polls `/api/health` until the service answers — failing the run (with the last 40
journal lines) if it does not come back.

It assumes the systemd + nginx setup above is already in place. Configure it once:

1. **Make a deploy key** and authorize it on the server:

   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/kusa-deploy -N '' -C 'github-actions'
   ssh-copy-id -i ~/.ssh/kusa-deploy.pub <user>@<host>
   ssh-keyscan -H <host>                     # copy this output for SSH_KNOWN_HOSTS
   ```

2. **Add the secrets** under *Settings → Secrets and variables → Actions*:

   | Secret | Value |
   | --- | --- |
   | `SSH_HOST` | Your server's hostname or IP |
   | `SSH_USER` | The user that owns the checkout and the systemd unit |
   | `SSH_KEY` | Contents of the **private** key (`~/.ssh/kusa-deploy`) |
   | `SSH_KNOWN_HOSTS` | The `ssh-keyscan` output — pinned, so a hijacked DNS record cannot collect the key |

   Optional *variables* (same page, "Variables" tab) override the defaults:
   `SSH_PORT` (`22`), `DEPLOY_PATH` (`apps/kusaapp`, relative to the user's home), and
   `SERVICE_NAME` (`habit-tracker`).

3. Create a **`production` environment** in the repo settings if you want a manual
   approval before each deploy — the job already targets it.

`config.json` and `habits.db` are excluded from the sync, so your token and your history
stay on the server and survive `--delete`. The health check reads the port and token from
the server's own `config.json`, so nothing about your instance is duplicated into GitHub.

Moving an existing instance is just the database: stop the old service, copy `habits.db`
(and `config.json`, to keep the token that browsers and the extension already hold) to the
new host, and start it there. Keeping the token means clients with the key in `localStorage`
or in the extension's settings only need their base URL updated.

> The token is the only thing standing between the open internet and your data once the
> site is public — use a long random string, and prefer a private network (VPN/tailnet) if
> you would rather not expose it at all.

## Agent skill

This repo ships an agent skill (`skill/kusa-app/`) so an OpenClaw/Codex-style agent can operate the tracker for you (check in, report streaks, …). See `skill/kusa-app/SKILL.md`.

## Chrome extension

A companion Chrome extension lives in [`chrome-extension/`](chrome-extension/) — a toolbar
**circular green gauge** (today's completion %) with a badge for the count of completed
habits, plus a popup for quick check-ins. It's a **client of the kusaapp API**
(`/api/state`, `/api/toggle`, `/api/habits`) with the server URL + token configured in the
popup's settings. The server sends CORS headers so the extension can fetch cross-origin.

## License

MIT
