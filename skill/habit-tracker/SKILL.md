---
name: habit-tracker
description: "Operate the self-hosted habit-tracker app (everyday-style): check in habits, report streaks, manage habits via its HTTP API."
---

# Habit Tracker

Operate the self-hosted habit tracker (`server.mjs`, node:sqlite, single file).

## Deployment facts

- Server dir: `/home/pco2699/apps/habit-tracker/`
- Listens on `127.0.0.1:8090` (port + token in `config.json` — **never commit/print the token**)
- Auth: `?key=<token>` query param or `Authorization: Bearer <token>`
- Start/restart: `pkill -f 'habit-tracker/server.mjs'`; then `cd ~/apps/habit-tracker && setsid node server.mjs > /tmp/habit-server.log 2>&1 < /dev/null &`
- UI: `http://127.0.0.1:8090/?key=<token>` (PWA; offline writes are queued client-side)

## API

- `GET /api/state` → `{ today, habits: [{ id, name, emoji, any_days, days, skips, streak, longest, total, done_now }] }`
- `POST /api/toggle` `{ habit_id, date? }` — check in / undo (date defaults to today, `YYYY-MM-DD`)
- `POST /api/skip` `{ habit_id, date? }` — toggle skip (diagonal slash; streak bridges over, total unchanged)
- `POST /api/habits` — `{ op:"create", name, emoji?, any_days?, all_days? }` (any_days = "any one of these days counts", all_days = "every selected day counts, others auto-skip"; weekday numbers 0=Sun…6=Sat) or `{ op:"delete", id }` (soft delete)

## Semantics

- Daily habits: streak counts consecutive days; skipped days bridge the streak.
- Any-of habits (`any_days`): one hit per period counts. Period = maximal run of consecutive allowed weekdays (Mon-based, wrap-aware: e.g. [0,6] is one weekend period). Toggling a non-allowed weekday returns 400.
- All-of habits (`all_days`): streak counts consecutive *scheduled* (allowed) days; non-allowed days bridge automatically (auto-skip). Toggling a non-allowed weekday returns 400.
- Theme: light/dark toggle in header, persisted in localStorage (`theme`), `?theme=dark|light` URL param also supported.
- `days` = check-ins, `skips` = skipped dates, `total` = check-ins only.

## Common tasks

- Daily report: `GET /api/state`, summarize each habit's streak/total, mention misses (done_now=false).
- Check in: `POST /api/toggle` with habit_id.
- Verify server: `GET /api/health` (with key) or check the port with `ss -tlnp | grep 8090`.

## Gotchas

- Do not inline the token in shell commands (it breaks in quotes/escaping); build URLs with `URL` + `searchParams` in a small Node script, or read `config.json` from a script.
- After editing `server.mjs`, run `node --check server.mjs` and verify the *served* page script too (extract `<script>` content and `node --check` it) — the HTML lives in a JS template literal, so backslashes need `\\`.
- `habits.db` and `config.json` must stay out of git (`.gitignore` covers them).
