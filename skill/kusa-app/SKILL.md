---
name: kusa-app
description: "Kusa is the user's self-hosted habit tracker. Use whenever they ask about their habits or check-ins — \"did I do everything today\", \"check in my run\", \"how am I doing on reading\", \"今日の習慣どう\" — or want to add or drop a habit."
---

# Kusa — their habit tracker

Kusa is where the user keeps their daily habits. It deliberately has **no streak counter**: every habit carries a **strength** (`score`, 0–100) instead — how well it's being kept lately, weighted so recent days matter most. Read and update that record for them, and talk in those terms: "reading's at 96%, that's about as solid as it gets" beats "total=60". Never invent a day count or tell them a run is broken — that number doesn't exist here, and the whole point is that one missed day is not a catastrophe.

The app runs in Japanese (`lang: ja`); answer in whichever language they asked in.

## What they ask for

**"Did I do everything today?"**
`GET /api/state`, then lead with what's still open (`done_now: false`). They want the gap, not a full dump of every habit.

**"Check in my run."** / **"ランニングやった"**
`POST /api/toggle` with the habit id. The same call undoes it if they say they logged it by mistake. Confirm it back with where the habit now stands — the strength is the part they're actually asking about.

**"I was sick / traveling — that one shouldn't count against me."**
That's `POST /api/skip`, *not* a check-in. A skipped day leaves the strength exactly where it was and doesn't inflate the total. Whenever they explain a miss rather than just admitting one, offer this instead of letting the day count as a zero.

**"How am I doing?"**
`score` (0–100) is the habit's strength — an exponentially smoothed average of the whole history, the way uhabits does it. `score_history` is the day-by-day version of it, so the trend is right there: compare the last entry with the one ~7 back and say whether it's climbing or slipping. `total` is lifetime check-ins. Read the number honestly: 90%+ is solid, ~50% is a coin flip, and a fall of several points over a week is worth naming.

**"I blew it this week."**
Say what it actually cost. A few missed days take a strong habit down a handful of points, not to zero — "you're at 72%, down from 80; two good days puts most of it back" is true, checkable against `score_history`, and the reason the app works this way.

**"Add a habit."** / **"Drop that one."**
`POST /api/habits` with `op: create` / `op: delete`. Deletes are soft and recoverable, but confirm first: from their side, the history disappears with it.

## How habits are shaped

Three kinds, and the kind decides whether a blank day is even a miss:

- **Daily** — every day counts; a missed day is a zero in the average.
- **Any-of** (`any_days`) — "sometime this weekend", "once during the week". One check-in anywhere in the period is enough. A period is a run of consecutive allowed weekdays and wraps around, so Sat+Sun is *one* weekend, not two chances.
- **All-of** (`all_days`) — "every weekday". Only scheduled days count; the rest cost nothing. An empty Sunday on a weekdays-only habit is not a miss — never report it as one.

Weekdays are `0`=Sun … `6`=Sat. Checking in on a day the habit doesn't run returns 400: that's the schedule talking, not a failure to retry.

## Talking to it

Base URL is whatever this deployment answers on: `http://127.0.0.1:<port>` when the server
runs on the same machine as you, otherwise the origin its reverse proxy serves. The server
itself always binds `127.0.0.1`, so a remote instance is only ever reachable through that proxy.
Token lives in `config.json` **on the server's host** — never print or commit it.
Auth: `?key=<token>` or `Authorization: Bearer <token>`.

| Call | Does |
| --- | --- |
| `GET /api/state` | everything: `{ today, habits: [{ id, name, emoji, any_days, all_days, days, skips, total, score, score_history, due_now, done_now }] }` — `?days=N` widens the window |
| `POST /api/toggle` `{ habit_id, date? }` | check in / undo; `date` defaults to today (`YYYY-MM-DD`) |
| `POST /api/skip` `{ habit_id, date? }` | mark skipped / unskip |
| `POST /api/habits` | `{ op:"create", name, emoji?, any_days?, all_days? }` → `{ id }`, or `{ op:"delete", id }` |
| `GET /api/health` | `{ ok: true }` |

`days` = check-in dates, `skips` = skipped dates, `total` counts check-ins only.
`score` = habit strength 0–100 today, `score_history` = one score per calendar day ending on `today`
(up to 180). Both are computed over the full history even when `days=N` clips the arrays.
There is no `streak` or `longest` field — the app has no streak counter.
`due_now` = the habit is scheduled for today; a habit that isn't is reported `done_now: true`,
because there is nothing to do. The app's ring counts only the `due_now` habits.

## Gotchas

- **"I checked in on my phone but it's gone."** The PWA queues writes locally while offline and flushes on reconnect — have them reopen the app on a connection before treating it as lost data.
- Don't inline the token in a shell one-liner; quoting mangles it. Read `config.json` from a small Node script and build URLs with `URL` + `searchParams`. If the server is on another host, keep a local copy of the base URL and token wherever you keep credentials — don't guess at `localhost`, it will just time out.
- After editing `server.mjs`: `node --check server.mjs`, then check the *served* page script too — that HTML lives inside a JS template literal, so backslashes need doubling.
- `habits.db` and `config.json` stay out of git.

## Running it

systemd owns the server: `systemctl --user restart habit-tracker`, logs via `journalctl --user -u habit-tracker -n 50` — **on whichever host runs it**, which is not necessarily the one you are on. For a remote deployment, prefix both with `ssh <host>`, and remember that editing `server.mjs` locally changes nothing until the file reaches that host.

Never `pkill` the process. It was killed that way once and stayed down overnight — the unit reads a plain SIGTERM as a deliberate stop. (`Restart=always` now recovers it, but a manual `setsid node server.mjs &` still leaves an unsupervised copy that dies with its session.)
