# Chrome extension — Habit Tracker Gauge

A Chrome extension that works as an **API client** for [kusaapp](../../../apps/habit-tracker/README.md), the self-hosted habit tracker.

It shows a green circular gauge of today's completed habits in the toolbar.

## How it works

- **Toolbar icon = circular gauge**
  - 0% → dark green circle (empty track)
  - A vivid green arc grows clockwise from 12 o'clock as completion rises
  - 100% → fully vivid green / 60% → arc covers 60%
- **Badge = number of required habits done today**
  - `?` = not configured, `!` = connection error (orange), digit = completed count
- **Click → popup** (add / check / delete habits + server settings)
- **What the gauge counts:** completion rate of today's due habits
  (daily habits + `all_days` habits whose weekday is today), excluding
  `any_days` (any-of-weekday) habits. Those still appear in the list but are
  excluded from the gauge.

## No local data

The extension stores no habit data itself — it only talks to the kusaapp API:

- `GET /api/state` — habit list + today's completion state (`done_now`)
- `POST /api/toggle` — toggle a check-in
- `POST /api/habits` — create (`op:"create"`) / delete (`op:"delete"`)
- Auth via `Authorization: Bearer <token>`

Server URL and token are entered in the popup's ⚙ Settings and stored in
`chrome.storage.local` (extension settings only; habit data lives server-side).

## Setup

1. Start the kusaapp server (`node server.mjs`). CORS is enabled so the
   extension can connect (`server.mjs` returns `Access-Control-Allow-Origin`).
2. In Chrome, open `chrome://extensions` → enable Developer mode →
   "Load unpacked" → select this folder.
3. Click the toolbar icon → ⚙ Settings → enter the server URL and token → Save.

## Files

- `manifest.json` — MV3 (module service worker + `host_permissions`)
- `background.js` — gauge rendering (OffscreenCanvas) + badge updates
- `common.js` — settings, API calls, progress math (shared by background/popup)
- `popup.html` / `popup.css` / `popup.js` — popup UI
