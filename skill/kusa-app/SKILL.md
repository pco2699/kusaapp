---
name: kusa-app
description: "Kusa is the user's self-hosted habit tracker. Use whenever they ask about their habits, streaks or check-ins — \"did I do everything today\", \"check in my run\", \"how's my streak\", \"今日の習慣どう\" — or want to add or drop a habit."
---

# Kusa — their habit tracker

Kusa is where the user keeps their daily habits. They think in **streaks**: an unbroken run is the whole point of the app, and breaking one stings. Read and update that record for them, and talk about it the way they do — "you're on day 12" beats "total=12".

The app runs in Japanese (`lang: ja`); answer in whichever language they asked in.

## What they ask for

**"Did I do everything today?"**
`GET /api/state`, then lead with what's still open (`done_now: false`). They want the gap, not a full dump of every habit.

**"Check in my run."** / **"ランニングやった"**
`POST /api/toggle` with the habit id. The same call undoes it if they say they logged it by mistake. Confirm the new streak back to them — that's the part they're actually asking about.

**"I was sick / traveling — don't break my streak."**
That's `POST /api/skip`, *not* a check-in. A skipped day keeps the run alive and doesn't inflate the total. Whenever they explain a miss rather than just admitting one, offer this instead of letting the streak die.

**"How am I doing?"**
`streak` is the current run, `longest` is their record, `total` is lifetime check-ins. When the current run is near the record, say so — that's the number they care about.

**"Add a habit."** / **"Drop that one."**
`POST /api/habits` with `op: create` / `op: delete`. Deletes are soft and recoverable, but confirm first: from their side, the history disappears with it.

## How habits are shaped

Three kinds, and the kind decides whether a blank day is even a miss:

- **Daily** — every day counts; the streak is consecutive days.
- **Any-of** (`any_days`) — "sometime this weekend", "once during the week". One check-in anywhere in the period is enough. A period is a run of consecutive allowed weekdays and wraps around, so Sat+Sun is *one* weekend, not two chances.
- **All-of** (`all_days`) — "every weekday". Only scheduled days count; the rest bridge the streak automatically. An empty Sunday on a weekdays-only habit is not a miss — never report it as one.

Weekdays are `0`=Sun … `6`=Sat. Checking in on a day the habit doesn't run returns 400: that's the schedule talking, not a failure to retry.

## Talking to it

Base URL is whatever this deployment answers on: `http://127.0.0.1:<port>` when the server
runs on the same machine as you, otherwise the origin its reverse proxy serves. The server
itself always binds `127.0.0.1`, so a remote instance is only ever reachable through that proxy.
Token lives in `config.json` **on the server's host** — never print or commit it.
Auth: `?key=<token>` or `Authorization: Bearer <token>`.

| Call | Does |
| --- | --- |
| `GET /api/state` | everything: `{ today, habits: [{ id, name, emoji, any_days, all_days, days, skips, streak, longest, total, done_now }] }` — `?days=N` widens the window |
| `POST /api/toggle` `{ habit_id, date? }` | check in / undo; `date` defaults to today (`YYYY-MM-DD`) |
| `POST /api/skip` `{ habit_id, date? }` | mark skipped / unskip |
| `POST /api/habits` | `{ op:"create", name, emoji?, any_days?, all_days? }` → `{ id }`, or `{ op:"delete", id }` |
| `GET /api/health` | `{ ok: true }` |

`days` = check-in dates, `skips` = skipped dates, `total` counts check-ins only.

## Gotchas

- **"I checked in on my phone but it's gone."** The PWA queues writes locally while offline and flushes on reconnect — have them reopen the app on a connection before treating it as lost data.
- Don't inline the token in a shell one-liner; quoting mangles it. Read `config.json` from a small Node script and build URLs with `URL` + `searchParams`. If the server is on another host, keep a local copy of the base URL and token wherever you keep credentials — don't guess at `localhost`, it will just time out.
- After editing `server.mjs`: `node --check server.mjs`, then check the *served* page script too — that HTML lives inside a JS template literal, so backslashes need doubling.
- `habits.db` and `config.json` stay out of git.

## Running it

systemd owns the server: `systemctl --user restart habit-tracker`, logs via `journalctl --user -u habit-tracker -n 50` — **on whichever host runs it**, which is not necessarily the one you are on. For a remote deployment, prefix both with `ssh <host>`, and remember that editing `server.mjs` locally changes nothing until the file reaches that host.

Never `pkill` the process. It was killed that way once and stayed down overnight — the unit reads a plain SIGTERM as a deliberate stop. (`Restart=always` now recovers it, but a manual `setsid node server.mjs &` still leaves an unsupervised copy that dies with its session.)
