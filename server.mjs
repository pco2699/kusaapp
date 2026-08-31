// Habit Tracker — zero-dependency Node server (node:sqlite built-in)
// API + single-page UI. Auth: ?key= or Authorization: Bearer <token>
// UI: mobile-first card layout
// v6 (2026-08-24): any-of-weekday habits, PWA + offline queue
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync, brotliCompressSync, constants as ZC } from 'node:zlib';

const ROOT = dirname(fileURLToPath(import.meta.url));
// KUSA_CONFIG points the process at a config file other than ./config.json, so one
// checkout can run several instances (and so the tests can run against their own).
const CONFIG_PATH = process.env.KUSA_CONFIG || join(ROOT, 'config.json');
const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const { port, token, lang } = CONFIG;
const LANG = lang === 'en' ? 'en' : 'ja';
// `db` is resolved against the config file, so a config elsewhere keeps its database
// beside it rather than in the checkout.
const DB_PATH = CONFIG.db ? join(dirname(CONFIG_PATH), CONFIG.db) : join(ROOT, 'habits.db');

const db = new DatabaseSync(DB_PATH);
db.exec(`
CREATE TABLE IF NOT EXISTS habits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  emoji TEXT DEFAULT '',
  archived INTEGER DEFAULT 0,
  sort INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS checkins (
  habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(habit_id, date)
);
`);
try { db.exec('ALTER TABLE habits ADD COLUMN any_days TEXT'); } catch {}
try { db.exec('ALTER TABLE checkins ADD COLUMN skip INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE habits ADD COLUMN all_days TEXT'); } catch {}

// Date helpers. These sit inside the streak walks, which run per habit per day, so a
// formatter built per call showed up as the single biggest cost in /api/state. The
// timezone-aware formatter is built once; the local-date one is plain string math
// (identical 'en-CA' YYYY-MM-DD output, none of the Intl overhead).
const TZ_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' });
function today() {
  return TZ_FMT.format(new Date());
}
function dateFmt(dt) {
  const m = dt.getMonth() + 1, d = dt.getDate();
  return dt.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type'
  };
}

// ---------- response bundles ----------
// A body plus its ETag and precompressed variants, so a given payload is hashed and
// compressed once and then reused across requests. `quality` picks the brotli level:
// the default (11/9) is for payloads built once at startup; pass 5 for bodies rebuilt
// at runtime, where compression time sits on the request's critical path.
const MIN_COMPRESS = 512;

function etagOf(buf) {
  return '"' + createHash('sha1').update(buf).digest('base64url') + '"';
}

function bundle(data, type, quality) {
  const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const b = { raw, type, etag: etagOf(raw), br: null, gz: null };
  // Images are already compressed; running them through brotli only burns CPU.
  if (raw.length >= MIN_COMPRESS && !type.startsWith('image/')) {
    b.br = brotliCompressSync(raw, {
      params: {
        [ZC.BROTLI_PARAM_QUALITY]: quality === undefined ? 11 : quality,
        [ZC.BROTLI_PARAM_SIZE_HINT]: raw.length
      }
    });
    b.gz = gzipSync(raw, { level: quality === undefined ? 9 : 6 });
    if (b.br.length >= raw.length) b.br = null;
    if (b.gz.length >= raw.length) b.gz = null;
  }
  return b;
}

function send(req, res, b, cacheControl, extra) {
  const h = {
    'Content-Type': b.type,
    'Cache-Control': cacheControl,
    'ETag': b.etag,
    'Vary': 'Accept-Encoding',
    ...corsHeaders(),
    ...extra
  };
  const inm = req.headers['if-none-match'];
  if (inm && inm.indexOf(b.etag) >= 0) {
    res.writeHead(304, h);
    return res.end();
  }
  const ae = String(req.headers['accept-encoding'] || '');
  let body = b.raw;
  if (b.br && /\bbr\b/.test(ae)) { body = b.br; h['Content-Encoding'] = 'br'; }
  else if (b.gz && /\bgzip\b/.test(ae)) { body = b.gz; h['Content-Encoding'] = 'gzip'; }
  h['Content-Length'] = String(body.length);
  res.writeHead(200, h);
  res.end(body);
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders() });
  res.end(body);
}

function authorized(req, urlObj) {
  const qk = urlObj.searchParams.get('key');
  const auth = req.headers['authorization'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return qk === token || bearer === token;
}

// A navigation to `/` carries neither the ?key= query (it is dropped after the first
// visit) nor an Authorization header, so without this the document could never be
// served with its state inlined after visit one. The cookie is accepted *only* for
// that document GET — every API route still demands ?key= or Bearer — and it is
// SameSite=Strict, so it is not attached to cross-site requests.
const COOKIE_NAME = 'kusa_key';
const SET_COOKIE = COOKIE_NAME + '=' + encodeURIComponent(token) +
  '; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict';

function cookieToken(req) {
  const raw = req.headers.cookie;
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE_NAME) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ''; }
    }
  }
  return '';
}

async function body(req) {
  let data = '';
  for await (const c of req) data += c;
  try { return JSON.parse(data || '{}'); } catch { return {}; }
}

function parseAnyDays(v) {
  if (!Array.isArray(v)) return null;
  const a = v.filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
  return a.length ? a : null;
}

// ---------- daily streak ----------
// Anchored on noon of the reference day and stepped with dateFmt, like the scheduled and
// period walks below: stepping a Date by a day and re-formatting it in a *different*
// timezone can land twice on the same calendar day across a DST shift.
function streakFor(daysSet, t) {
  const d = new Date(t + 'T12:00:00');
  if (!daysSet.has(dateFmt(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (daysSet.has(dateFmt(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
function longestFor(daysSet) {
  const arr = [...daysSet].sort();
  let best = 0, cur = 0, prev = null;
  for (const d of arr) {
    if (prev) {
      const nd = new Date(prev + 'T12:00:00');
      nd.setDate(nd.getDate() + 1);
      cur = (dateFmt(nd) === d) ? cur + 1 : 1;
    } else cur = 1;
    prev = d;
    if (cur > best) best = cur;
  }
  return best;
}

// ---------- any-of-weekday period streak ----------
function monBased(dt) { const w = dt.getDay(); return w === 0 ? 7 : w; }
// split allowed weekdays into maximal consecutive runs (Mon-based 1..7, wrap-aware)
function weekRuns(allowed) {
  const mon = [...allowed].map(d => d === 0 ? 7 : d).sort((a, b) => a - b);
  const runs = []; let cur = [];
  for (const d of mon) {
    if (cur.length && d === cur[cur.length - 1] + 1) cur.push(d);
    else { if (cur.length) runs.push(cur); cur = [d]; }
  }
  if (cur.length) runs.push(cur);
  if (runs.length > 1 && runs[0][0] === 1 && runs[runs.length - 1][runs[runs.length - 1].length - 1] === 7) {
    const last = runs.pop();
    runs[0] = [...last, ...runs[0]];
  }
  return runs;
}
function periodInfo(ds, runs) {
  const d = new Date(ds + 'T12:00:00');
  const w = monBased(d);
  const monday = new Date(d); monday.setDate(monday.getDate() - (w - 1));
  const wk = Math.round(monday.getTime() / (7 * 86400000));
  for (let i = 0; i < runs.length; i++) {
    if (runs[i].includes(w)) return { key: wk + ':' + i, idx: i, wk };
  }
  return null;
}
function streakPeriods(satKeys, skipKeys, todayStr, runs, allowed) {
  let n = 0; const seen = new Set();
  const d = new Date(todayStr + 'T12:00:00');
  for (let i = 0; i < 800; i++) {
    if (allowed.has(d.getDay())) {
      const pi = periodInfo(dateFmt(d), runs);
      if (pi && !seen.has(pi.key)) {
        seen.add(pi.key);
        if (satKeys.has(pi.key) || skipKeys.has(pi.key)) n++;
        else if (i === 0) { /* current period still in progress: pending */ }
        else return n;
      }
    }
    d.setDate(d.getDate() - 1);
  }
  return n;
}
// Periods are numbered densely — `runsPerWeek` slots per week — so that the last period
// of one week and the first of the next come out adjacent. Spacing them any wider (a
// fixed 8, say) leaves a gap at every week boundary, and a habit with one period per
// week could then never show a longest run above 1.
function longestPeriods(keys, runsPerWeek) {
  const arr = [...keys].map(k => { const p = k.split(':'); return Number(p[0]) * runsPerWeek + Number(p[1]); }).sort((a, b) => a - b);
  let best = 0, cur = 0, prev = null;
  for (const o of arr) { cur = (prev !== null && o === prev + 1) ? cur + 1 : 1; prev = o; if (cur > best) best = cur; }
  return best;
}

// ---------- all-of-weekday scheduled streak ----------
// streak counts consecutive *scheduled* days; non-scheduled days bridge automatically
function streakScheduled(unionSet, allowed, todayStr) {
  let n = 0; const d = new Date(todayStr + 'T12:00:00');
  for (let i = 0; i < 800; i++) {
    if (allowed.has(d.getDay())) {
      const ds = dateFmt(d);
      if (unionSet.has(ds)) n++;
      else if (ds !== todayStr) return n;
    }
    d.setDate(d.getDate() - 1);
  }
  return n;
}
function longestScheduled(unionSet, allowed, todayStr) {
  if (!unionSet.size) return 0;
  let best = 0, cur = 0;
  const d = new Date([...unionSet].sort()[0] + 'T12:00:00');
  const end = new Date(todayStr + 'T12:00:00');
  while (d <= end) {
    if (allowed.has(d.getDay())) {
      if (unionSet.has(dateFmt(d))) { cur++; if (cur > best) best = cur; }
      else cur = 0;
    }
    d.setDate(d.getDate() + 1);
  }
  return best;
}

// Statements are compiled once at startup rather than on every request.
const Q_HABITS = db.prepare('SELECT id, name, emoji, any_days, all_days FROM habits WHERE archived=0 ORDER BY sort, id');
const Q_CHECKINS = db.prepare('SELECT habit_id, date, skip FROM checkins ORDER BY date');
const Q_HABIT_DAYS = db.prepare('SELECT any_days, all_days FROM habits WHERE id=? AND archived=0');
const Q_CHECKIN_ONE = db.prepare('SELECT skip FROM checkins WHERE habit_id=? AND date=?');
const Q_CHECKIN_DEL = db.prepare('DELETE FROM checkins WHERE habit_id=? AND date=?');
const Q_CHECKIN_ADD = db.prepare('INSERT INTO checkins (habit_id, date) VALUES (?, ?)');
const Q_SKIP_ADD = db.prepare('INSERT INTO checkins (habit_id, date, skip) VALUES (?, ?, 1)');
const Q_HABIT_ARCHIVE = db.prepare('UPDATE habits SET archived=1 WHERE id=?');
const Q_HABIT_ADD = db.prepare('INSERT INTO habits (name, emoji, any_days, all_days) VALUES (?, ?, ?, ?)');

// `t` is the day to report on ('YYYY-MM-DD'); it defaults to today and is passed
// explicitly by the tests, which need to ask about a specific weekday.
function getState(t = today()) {
  const habits = Q_HABITS.all();
  const out = [];
  // One scan of checkins bucketed by habit, instead of a query per habit.
  const byHabit = new Map();
  for (const h of habits) byHabit.set(h.id, { checked: [], skips: [] });
  for (const r of Q_CHECKINS.all()) {
    const b = byHabit.get(r.habit_id);
    if (b) (r.skip ? b.skips : b.checked).push(r.date);
  }
  for (const h of habits) {
    const { checked, skips } = byHabit.get(h.id);
    let any = null;
    try { any = h.any_days ? parseAnyDays(JSON.parse(h.any_days)) : null; } catch {}
    let all = null;
    try { all = h.all_days ? parseAnyDays(JSON.parse(h.all_days)) : null; } catch {}
    if (all) {
      const allowed = new Set(all);
      const union = new Set([...checked, ...skips]);
      const due = allowed.has(new Date(t + 'T12:00:00').getDay());
      out.push({
        id: h.id, name: h.name, emoji: h.emoji, any_days: null, all_days: all, total: checked.length,
        streak: streakScheduled(union, allowed, t),
        longest: longestScheduled(union, allowed, t),
        days: checked, skips, due_now: due,
        done_now: due ? checked.includes(t) : true
      });
    } else if (any) {
      const allowed = new Set(any);
      const runs = weekRuns(any);
      const satKeys = new Set(checked.map(ds => { const pi = periodInfo(ds, runs); return pi && pi.key; }).filter(Boolean));
      const skipKeys = new Set(skips.map(ds => { const pi = periodInfo(ds, runs); return pi && pi.key; }).filter(Boolean));
      // done_now: only the period today itself falls in. On a weekday the habit isn't
      // scheduled for there is nothing to do, so it counts as done rather than dragging
      // the day's count down with a period that closed days ago — the same way an
      // all-of-weekday habit is done_now on a day it isn't scheduled.
      const due = allowed.has(new Date(t + 'T12:00:00').getDay());
      const todayPi = due ? periodInfo(t, runs) : null;
      out.push({
        id: h.id, name: h.name, emoji: h.emoji, any_days: any, all_days: null, total: checked.length,
        streak: streakPeriods(satKeys, skipKeys, t, runs, allowed),
        longest: longestPeriods(new Set([...satKeys, ...skipKeys]), runs.length),
        days: checked, skips, due_now: due,
        done_now: todayPi ? satKeys.has(todayPi.key) : true
      });
    } else {
      const union = new Set([...checked, ...skips]);
      out.push({
        id: h.id, name: h.name, emoji: h.emoji, any_days: null, all_days: null, total: checked.length,
        streak: streakFor(union, t), longest: longestFor(union),
        days: checked, skips, due_now: true, done_now: checked.includes(t)
      });
    }
  }
  return { today: t, habits: out };
}

// ---------- state cache ----------
// State only changes on writes (or when the day rolls over), so the computed state,
// its JSON body and the state-inlined HTML document are all built once and reused.
// This keeps the first page view off both the SQLite queries and the streak math.
let stateCache = null;

// The grid never shows more than 45 days, and the heat shade saturates after 5
// consecutive days, so the UI only ever reads a recent slice of the history. Bounding
// what the first page view carries keeps its size flat as years of check-ins pile up;
// streak/longest/total are computed server-side over the *full* history either way.
const BOOT_DAYS = 180;

function cutoff(days) {
  const d = new Date(today() + 'T12:00:00');
  d.setDate(d.getDate() - days);
  return dateFmt(d);
}

// Same state, with the per-habit date arrays clipped to the last `days` days.
function sliceState(state, days) {
  const from = cutoff(days);
  return {
    today: state.today,
    habits: state.habits.map(h => ({
      ...h,
      days: h.days.filter(d => d >= from),
      skips: h.skips.filter(d => d >= from)
    }))
  };
}

function stateEntry() {
  const t = today();
  if (stateCache && stateCache.day === t) return stateCache;
  const state = getState(t);
  stateCache = {
    day: t,
    state,
    json: bundle(JSON.stringify(state), 'application/json; charset=utf-8', 5),
    slices: new Map(),
    html: null
  };
  return stateCache;
}

// JSON body for /api/state. No `days` -> the full history, so the documented API and
// the Chrome extension are unaffected; the web UI asks for the slice it actually uses.
function stateJson(days) {
  const sc = stateEntry();
  if (!days) return sc.json;
  let b = sc.slices.get(days);
  if (!b) {
    b = bundle(JSON.stringify(sliceState(sc.state, days)), 'application/json; charset=utf-8', 5);
    sc.slices.set(days, b);
  }
  return b;
}

function invalidateState() { stateCache = null; }

// A value destined for a <script> block: neutralize anything that could end the element
// early or break the parse. The state is passed through as a *string* so the browser
// runs one JSON.parse over it, which is markedly cheaper than having the JS parser
// work through the equivalent object literal.
function jsonForScript(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// ---------- PWA assets ----------
const MANIFEST = JSON.stringify({
  name: 'Kusa',
  short_name: 'Kusa',
  start_url: './?source=pwa',
  display: 'standalone',
  background_color: '#f6f7fb',
  theme_color: '#f6f7fb',
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
  ]
});

const SW = `const V = 'habits-v2';
const SCOPE = new URL(self.registration.scope);
function abs(p) { return new URL(p, SCOPE).toString(); }
const SHELL = [abs('./'), abs('./manifest.webmanifest'), abs('./icon-192.png'), abs('./icon-512.png')];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const isApi = url.pathname.indexOf('/api/') >= 0;
  if (isApi) {
    e.respondWith(
      fetch(req).then(r => {
        const cp = r.clone();
        caches.open(V).then(c => c.put(req, cp));
        return r;
      }).catch(() => caches.match(req).then(m => m || new Response('{"offline":true}', { status: 503, headers: { 'Content-Type': 'application/json' } })))
    );
  } else {
    // Stale-while-revalidate: answer from the cache immediately (the shell now carries
    // the inlined state, so this is a complete first paint with no network at all),
    // then refresh the entry in the background. Plain cache-first pinned both the state
    // and the app code to whatever was cached at install time.
    e.respondWith(
      caches.match(req, { ignoreSearch: true, ignoreVary: true }).then(m => {
        const net = fetch(req).then(r => {
          if (r && r.ok) {
            const cp = r.clone();
            caches.open(V).then(c => c.put(req, cp));
          }
          return r;
        }).catch(err => { if (m) return m; throw err; });
        return m || net;
      })
    );
  }
});
`;

const SW_BUNDLE = bundle(SW, 'application/javascript; charset=utf-8');
const MANIFEST_BUNDLE = bundle(MANIFEST, 'application/manifest+json');

// Icons are read into memory once instead of hitting the disk synchronously on every
// request (a sync read blocks the whole event loop).
function assetBundle(file, type) {
  try { return bundle(readFileSync(join(ROOT, file)), type); } catch { return null; }
}
const ICON_192 = assetBundle('icon-192.png', 'image/png');
const ICON_512 = assetBundle('icon-512.png', 'image/png');
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'private, no-cache';

const HTML_SHELL = `<!doctype html>
<html lang="${LANG}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" id="meta-theme" content="#f6f7fb">
<title>Kusa</title>
<!-- Inline SVG favicon: static (so the preload scanner sees it) and free, where the
     192px PNG cost a 24KB download on every cold first view just to fill the tab. -->
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%2310b981'/><path d='M16 25V15' stroke='%23fff' stroke-width='2.4' stroke-linecap='round'/><path d='M16 17c0-4 3-7 7-7 0 4-3 7-7 7Z' fill='%23fff'/><path d='M16 21c0-3-2.5-5.5-5.5-5.5 0 3 2.5 5.5 5.5 5.5Z' fill='%23d1fae5'/></svg>">
<script>
  (function () {
    // Theme is resolved here, above the stylesheet, so the first paint already uses the
    // right palette. Deciding this further down meant dark-mode users saw a white flash
    // and paid for a second full repaint.
    var th = null;
    try {
      var qp = new URLSearchParams(location.search).get('theme');
      if (qp === 'dark' || qp === 'light') localStorage.setItem('theme', qp);
      th = localStorage.getItem('theme');
    } catch (e) {}
    if (!th) th = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', th);
    var mt = document.getElementById('meta-theme');
    if (mt) mt.setAttribute('content', th === 'dark' ? '#12141c' : '#f6f7fb');

    var b = location.pathname;
    if (b.charAt(b.length - 1) !== '/') b += '/';
    function l(rel, href) { var e = document.createElement('link'); e.rel = rel; e.href = b + href; document.head.appendChild(e); }
    l('manifest', 'manifest.webmanifest');
    l('apple-touch-icon', 'icon-192.png');
  })();
</script>
<style>
  :root {
    color-scheme: light;
    --bg:#f6f7fb; --tx:#1c2333; --sub:#8a93a6; --card:#fff; --line:#eef0f5;
    --cell:#eef0f5; --inset:#f0f1f6; --slash:#b8c0cc; --soft:#f2f3f8;
    --ringbg:#e7eaf1; --btn:#1c2333; --btn-tx:#fff; --mix:#fff; --bord:#d3d8e0;
    --errbg:#fee2e2; --errtx:#b91c1c;
  }
  html[data-theme="dark"] {
    color-scheme: dark;
    --bg:#12141c; --tx:#e8ebf2; --sub:#8b93a7; --card:#1a1e29; --line:#262b38;
    --cell:#262b38; --inset:#222735; --slash:#4a5164; --soft:#252a38;
    --ringbg:#2c3242; --btn:#e8ebf2; --btn-tx:#12141c; --mix:#1a1e29; --bord:#3a4257;
    --errbg:#3b1f1f; --errtx:#fca5a5;
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin:0 auto; max-width:min(3400px, 96vw); background:var(--bg); color:var(--tx); font-family:-apple-system,'Segoe UI',system-ui,sans-serif; padding:20px 18px 120px; }
  @media (min-width: 900px) {
    body { padding-left:50px; padding-right:50px; max-width:min(3400px, calc(100vw - 100px)); }
  }

  .header { display:flex; align-items:center; gap:14px; margin-bottom:16px; padding:0 4px; }
  .logo { font-size:30px; font-weight:800; letter-spacing:-.6px; flex:1; }
  .logo span { color:#10b981; }
  #today-line { color:var(--sub); font-size:14px; font-weight:500; margin-top:2px; }
  #theme-btn { width:40px; height:40px; border-radius:50%; border:none; background:var(--soft); color:var(--tx); font-size:17px; cursor:pointer; flex:none; padding:0; }
  .ringwrap { position:relative; width:64px; height:64px; }
  .ringwrap svg { transform:rotate(-90deg); }
  .ringbg { fill:none; stroke:var(--ringbg); stroke-width:6; }
  #ring { fill:none; stroke:#3b82f6; stroke-width:6; stroke-linecap:round; stroke-dasharray:150.8; stroke-dashoffset:150.8; transition:stroke-dashoffset .5s cubic-bezier(.22,1,.36,1); }
  #ring-label { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-size:14px; font-weight:700; color:var(--tx); }

  .board { background:var(--card); border-radius:22px; box-shadow:0 1px 2px rgba(20,30,60,.05), 0 10px 28px rgba(20,30,60,.06); overflow:hidden; }

  .dates { display:grid; grid-template-columns:repeat(var(--n,7), minmax(0,64px)); justify-content:center; gap:6px; padding:14px 14px 10px; border-bottom:1px solid var(--line); }
  .dates.dense .dow { display:none; }
  .dates.dense .dcol { gap:2px; }
  .dates.dense .dnum { width:auto; height:auto; font-size:14px; color:var(--sub); }
  .dates.dense .dcol.today .dnum { width:30px; height:30px; font-size:13.5px; background:#10b981; color:#fff; }
  .dcol { display:flex; flex-direction:column; align-items:center; gap:4px; }
  .dow { font-size:11.5px; color:var(--sub); font-weight:600; }
  .dnum { width:34px; height:34px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:15.5px; font-weight:600; color:var(--tx); }
  .dcol.today .dow { color:#10b981; font-weight:700; }
  .dcol.today .dnum { background:#10b981; color:#fff; }

  /* Habits below the fold are skipped during the first layout/paint and rendered as
     they scroll into view; the browser remembers each block's real height after that. */
  .habit { padding:14px 14px 16px; border-bottom:1px solid var(--line);
           content-visibility:auto; contain-intrinsic-size:auto 118px; }
  .habit:last-child { border-bottom:none; }
  .hhead { display:flex; align-items:center; gap:11px; margin-bottom:8px; }
  .hemoji { width:46px; height:46px; border-radius:14px; display:flex; align-items:center; justify-content:center; font-size:23px; flex:none; }
  .htxt { min-width:0; flex:1; }
  .htxt .nm { font-size:17.5px; font-weight:700; line-height:1.3; overflow-wrap:anywhere; }
  .htxt .sub { font-size:11.5px; color:var(--sub); margin-top:2px; font-weight:600; }
  .hbtns { display:flex; gap:8px; flex:none; }
  .hbtn { background:none; border:none; color:var(--sub); font-size:19px; padding:4px 6px; cursor:pointer; border-radius:9px; line-height:1; }
  .hbtn:active { background:var(--soft); }
  .hbtn.menu { font-size:23px; }
  .hbtn.info { transform:translateY(2px); }

  .badges { display:flex; gap:7px; margin:0 0 12px 57px; }
  .badge { width:42px; height:42px; border-radius:50%; display:flex; flex-direction:column; align-items:center; justify-content:center; }
  .badge b { font-size:15.5px; font-weight:800; line-height:1; }
  .badge small { font-size:8.5px; font-weight:600; line-height:1; margin-top:2px; opacity:.8; }
  .badge.cur { background:var(--c); color:#fff; }
  .badge.best { background:color-mix(in srgb, var(--c) 14%, var(--mix)); color:var(--c); }
  .badge.tot { background:var(--soft); color:var(--sub); }

  .cells { display:grid; grid-template-columns:repeat(var(--n,7), minmax(0,80px)); justify-content:center; gap:6px; }
  .cells .hcell { max-height:64px; }
  .cells.dense .hcell { max-height:88px; }
  .hcell { aspect-ratio:1; border-radius:14px; background:var(--cell); cursor:pointer; transition:transform .1s; }
  /* Streak heat as five classes rather than an inline color-mix() on every filled cell:
     the browser parses these once instead of once per cell. --c comes from .habit. */
  .hcell.on { background:color-mix(in srgb, var(--c) 40%, var(--mix)); }
  .hcell.h2 { background:color-mix(in srgb, var(--c) 55%, var(--mix)); }
  .hcell.h3 { background:color-mix(in srgb, var(--c) 70%, var(--mix)); }
  .hcell.h4 { background:color-mix(in srgb, var(--c) 85%, var(--mix)); }
  .hcell.h5 { background:var(--c); }
  .hcell:active { transform:scale(1.15); }
  .hcell.today { box-shadow:0 0 0 2.5px var(--card), 0 0 0 4.5px var(--c); }
  .hcell.skip { background-color:var(--cell); background-image:linear-gradient(to top right, transparent calc(50% - 1.5px), var(--slash) calc(50% - 1.5px) calc(50% + 1.5px), transparent calc(50% + 1.5px)); }
  .hcell.off { background:transparent; box-shadow:inset 0 0 0 1.5px var(--inset); cursor:default; pointer-events:none; }

  .empty { text-align:center; color:var(--sub); padding:52px 0; font-size:15px; }
  #err { display:none; background:var(--errbg); color:var(--errtx); border-radius:14px; padding:12px 16px; margin:0 4px 14px; font-size:14px; }

  .addbtn { position:fixed; bottom:22px; left:50%; transform:translateX(-50%);
            background:var(--btn); color:var(--btn-tx); border:none; border-radius:18px; padding:16px 30px;
            font-size:16px; font-weight:700; cursor:pointer; z-index:10;
            box-shadow:0 6px 18px rgba(20,30,60,.3); }
  .addbtn:active { transform:translateX(-50%) scale(.96); }

  dialog { position:fixed; inset:0; margin:auto; background:var(--card); color:var(--tx); border:none; border-radius:20px; padding:24px; width:min(360px, 88vw);
           box-shadow:0 20px 60px rgba(20,30,60,.25); }
  @media (max-width:520px) {
    dialog { top:12px; bottom:auto; left:50%; right:auto; transform:translateX(-50%); margin:0; width:min(360px, 94vw);
             max-height:calc(100vh - 24px); max-height:calc(100dvh - 24px); overflow:auto; }
  }
  dialog::backdrop { background:rgba(20,25,40,.4); backdrop-filter:blur(3px); }
  dialog h3 { margin:0 0 16px; font-size:19px; }
  dialog .fld { display:flex; gap:8px; }
  dialog input { background:var(--soft); border:none; outline:none; border-radius:13px; padding:13px 14px; font-size:16px; color:var(--tx); }
  dialog input[name=name] { flex:1; }
  .emojibtn { width:60px; height:48px; border:none; border-radius:13px; background:var(--soft); color:var(--tx); font-size:24px; cursor:pointer; flex:none; display:flex; align-items:center; justify-content:center; }
  .emojipicker { display:none; margin-top:12px; background:var(--soft); border:1px solid var(--line); border-radius:14px; padding:10px; max-height:240px; overflow:auto; }
  .emojipicker.open { display:block; }
  .emojipicker .erow { display:grid; grid-template-columns:repeat(8, 1fr); gap:4px; }
  .emojipicker .erow button { background:none; border:none; font-size:22px; padding:6px 2px; cursor:pointer; border-radius:8px; }
  .emojipicker .erow button:active { background:var(--ringbg); }
  dialog menu { display:flex; justify-content:flex-end; gap:8px; margin:18px 0 0; padding:0; }
  dialog .ghost { background:none; border:none; color:var(--sub); font-weight:600; padding:11px 15px; cursor:pointer; font-size:15px; }
  dialog .primary { background:var(--btn); border:none; color:var(--btn-tx); font-weight:700; border-radius:13px; padding:11px 22px; cursor:pointer; font-size:15px; }

  .modes { display:flex; gap:8px; margin:16px 0 10px; }
  .modes label { flex:1; display:flex; align-items:center; justify-content:center; gap:6px;
                 border:1.5px solid var(--bord); border-radius:12px; padding:9px 6px; font-size:13px; font-weight:600; color:var(--sub); cursor:pointer; }
  .modes label.sel { border-color:var(--btn); background:var(--btn); color:var(--btn-tx); }
  .modes input { display:none; }
  .dowsel { display:none; }
  dialog.any .dowsel, dialog.all .dowsel { display:block; }
  .chips { display:flex; gap:6px; justify-content:center; }
  .chip { width:38px; height:38px; border-radius:50%; border:1.5px solid var(--bord); background:var(--card); color:var(--sub);
          font-size:13px; font-weight:700; cursor:pointer; }
  .chip.on { background:#10b981; border-color:#10b981; color:#fff; }
  .presets { display:flex; gap:6px; justify-content:center; margin-top:10px; }
  .pre { border:none; background:var(--soft); color:var(--sub); font-size:12px; font-weight:600; border-radius:9px; padding:7px 12px; cursor:pointer; }
  .stats { display:flex; gap:16px; justify-content:center; margin:10px 0 6px; }
  .stat { display:flex; flex-direction:column; align-items:center; gap:8px; }
  .stat .badge { width:60px; height:60px; }
  .stat .badge b { font-size:22px; }
  .stat > span { color:var(--sub); font-size:12.5px; font-weight:600; }
  #hmenu { position:fixed; z-index:50; background:var(--card); border:1px solid var(--line); border-radius:14px; box-shadow:0 8px 24px rgba(20,30,60,.22); padding:6px; display:none; min-width:150px; }
  #hmenu.open { display:block; }
  #hmenu button { display:block; width:100%; text-align:left; background:none; border:none; color:var(--tx); font-size:14px; padding:10px 12px; border-radius:9px; cursor:pointer; }
  #hmenu button:hover { background:var(--soft); }
  #hmenu button.danger { color:#ef4444; }
</style>
</head><body>
<div class="header">
  <div>
    <div class="logo">Ku<span>sa</span></div>
    <div id="today-line"></div>
  </div>
  <button id="theme-btn" onclick="toggleTheme()">🌙</button>
  <div class="ringwrap">
    <svg width="64" height="64" viewBox="0 0 64 64">
      <circle class="ringbg" cx="32" cy="32" r="24"></circle>
      <circle id="ring" cx="32" cy="32" r="24"></circle>
    </svg>
    <div id="ring-label">–</div>
  </div>
</div>

<div id="err"></div>
<div class="board">
  <div class="dates" id="dates"></div>
  <div id="rows"></div>
</div>

<button class="addbtn" id="addbtn" onclick="openAdd()"></button>

<dialog id="adddlg"><form method="dialog">
  <h3 id="newhabit-title"></h3>
  <div class="fld">
    <button type="button" class="emojibtn" id="emojibtn" onclick="toggleEmoji()">🙂</button>
    <input name="name" id="name-input" placeholder="">
  </div>
  <div class="emojipicker" id="emojipicker"></div>
  <input type="hidden" name="emoji" id="emoji-val" value="">
  <div class="modes" id="modes">
    <label class="sel"><input type="radio" name="mode" value="daily" checked><span class="mlbl" data-i="modeDaily"></span></label>
    <label><input type="radio" name="mode" value="any"><span class="mlbl" data-i="modeAny"></span></label>
    <label><input type="radio" name="mode" value="all"><span class="mlbl" data-i="modeAll"></span></label>
  </div>
  <div class="dowsel">
    <div class="chips" id="dows">
      <button type="button" class="chip" data-w="1">月</button>
      <button type="button" class="chip" data-w="2">火</button>
      <button type="button" class="chip" data-w="3">水</button>
      <button type="button" class="chip" data-w="4">木</button>
      <button type="button" class="chip" data-w="5">金</button>
      <button type="button" class="chip" data-w="6">土</button>
      <button type="button" class="chip" data-w="0">日</button>
    </div>
    <div class="presets">
      <button type="button" class="pre" data-p="weekday">平日</button>
      <button type="button" class="pre" data-p="weekend">土日</button>
      <button type="button" class="pre" data-p="all">全部</button>
    </div>
  </div>
  <menu><button class="ghost" type="button" onclick="closeAdd()">キャンセル</button>
  <button class="primary" value="ok">追加</button></menu>
</form></dialog>

<dialog id="authdlg"><form method="dialog"><p id="auth-text"></p>
<input name="key" style="width:100%"><menu><button class="primary">OK</button></menu></form></dialog>

<dialog id="statsdlg"><form method="dialog">
  <h3 id="stats-title"></h3>
  <div class="stats">
    <div class="stat">
      <div class="badge cur"><b id="stats-cur"></b></div>
      <span id="stats-cur-label"></span>
    </div>
    <div class="stat">
      <div class="badge best"><b id="stats-best"></b></div>
      <span id="stats-best-label"></span>
    </div>
    <div class="stat">
      <div class="badge tot"><b id="stats-total"></b></div>
      <span id="stats-total-label"></span>
    </div>
  </div>
  <menu><button class="ghost" value="ok">OK</button></menu>
</form></dialog>

<div id="hmenu"></div>
`;

// Split here so the server can slot the initial state in between: the document the
// browser receives already carries the data the app would otherwise have to fetch.
const HTML_APP = `<script>
let KEY = localStorage.getItem('key') || new URLSearchParams(location.search).get('key');
if (KEY) localStorage.setItem('key', KEY);
// Matches the slice the server inlines into this document, so the revalidating fetch
// asks for exactly the same payload and usually costs nothing but a 304.
const BOOT_DAYS = ${BOOT_DAYS};

// ---------- i18n ----------
const LANG = ${JSON.stringify(LANG)};
const I18N = {
  ja: {
    themeToggle:'テーマ切替', addHabit:'＋ 新しい習慣', newHabit:'新しい習慣', habitName:'習慣の名前',
    chooseIcon:'アイコン選択', modeDaily:'毎日', modeAny:'選んだ曜日の<br>どれか1回でOK', modeAll:'選んだ曜日<br>すべて',
    weekday:'平日', weekend:'土日', allDays:'全部', cancel:'キャンセル', add:'追加', enterKey:'🔑 アクセスキーを入力',
    empty:'🌱 「＋ 新しい習慣」から最初の習慣を追加しよう', offline:'オフライン — キャッシュ表示中',
    streakCur:'現在のストリーク', streakPeriod:'連続達成期間', badgeCur:'現在', badgeBest:'最長', badgeTotal:'累計',
    bestTitle:'最長', totalTitle:'累計', delete:'削除', delConfirm1:'「', delConfirm2:'」を削除？', stats:'統計', more:'メニュー',
    skip:'スキップ', streak:'連続', day:'日', skipHint:'長押し/右クリックでスキップ',
    daySep:'・', anySuffix:'のどれか1回', allSuffix:' すべて'
  },
  en: {
    themeToggle:'Toggle theme', addHabit:'＋ New habit', newHabit:'New habit', habitName:'Habit name',
    chooseIcon:'Choose icon', modeDaily:'Daily', modeAny:'Any of the<br>selected days', modeAll:'All of the<br>selected days',
    weekday:'Weekdays', weekend:'Weekend', allDays:'All', cancel:'Cancel', add:'Add', enterKey:'🔑 Enter access key',
    empty:'🌱 Add your first habit with the ＋ button', offline:'Offline — showing cached data',
    streakCur:'Current streak', streakPeriod:'Streak periods', badgeCur:'cur', badgeBest:'best', badgeTotal:'total',
    bestTitle:'Longest streak', totalTitle:'Total check-ins', delete:'Delete', delConfirm1:'Delete "', delConfirm2:'"?', stats:'Stats', more:'Menu',
    skip:'skip', streak:'streak', day:'d', skipHint:'long-press/right-click to skip',
    daySep:'/', anySuffix:' (any one)', allSuffix:' (all)'
  }
};
function t(k){ var d = I18N[LANG] || I18N.en; return (d && d[k] !== undefined) ? d[k] : k; }
function applyI18n(){
  document.getElementById('addbtn').textContent = t('addHabit');
  document.getElementById('newhabit-title').textContent = t('newHabit');
  document.getElementById('name-input').placeholder = t('habitName');
  document.getElementById('emojibtn').title = t('chooseIcon');
  const tb = document.getElementById('theme-btn');
  tb.title = t('themeToggle');
  tb.textContent = curTheme() === 'dark' ? '☀️' : '🌙';
  document.querySelectorAll('#modes .mlbl').forEach(function(el){ el.innerHTML = t(el.dataset.i); });
  document.querySelectorAll('#dows .chip').forEach(function(c){ c.textContent = DOW[Number(c.dataset.w)]; });
  var PM = { weekday:'weekday', weekend:'weekend', all:'allDays' };
  document.querySelectorAll('.presets .pre').forEach(function(el){ el.textContent = t(PM[el.dataset.p]); });
  document.querySelector('#adddlg .ghost').textContent = t('cancel');
  document.querySelector('#adddlg .primary').textContent = t('add');
  document.getElementById('auth-text').innerHTML = t('enterKey');
}

const PALETTE = ['#ff6b6b','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ec4899','#14b8a6','#f97316','#6366f1','#84cc16'];
const DOW = LANG === 'en' ? ['Su','Mo','Tu','We','Th','Fr','Sa'] : ['日','月','火','水','木','金','土'];

// ---------- theme ----------
// The theme itself is already applied by the bootstrap script in <head>; this only
// handles the toggle and keeps the button glyph in sync.
function curTheme(){ return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; }
function applyTheme(th){
  document.documentElement.setAttribute('data-theme', th);
  const b = document.getElementById('theme-btn');
  if (b) b.textContent = th === 'dark' ? '☀️' : '🌙';
  const mt = document.querySelector('meta[name=theme-color]');
  if (mt) mt.setAttribute('content', th === 'dark' ? '#12141c' : '#f6f7fb');
}
function toggleTheme(){
  const cur = curTheme() === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('theme', cur); } catch (e) {}
  applyTheme(cur);
}

// responsive day count: more days on wider screens, capped at 45 for readability
function calcDays(){
  const w = document.documentElement.clientWidth;
  if (w < 520) return 7;
  const n = Math.floor((w - 60) / 70);
  return Math.max(14, Math.min(45, n));
}
let N_DAYS = calcDays();

function err(m){ const e=document.getElementById('err'); e.style.display='block'; e.textContent='⚠️ '+m; }
window.addEventListener('error', ev => err(ev.message));
window.addEventListener('unhandledrejection', ev => err(String(ev.reason && ev.reason.message || ev.reason)));
function showAuth(){ const d=document.getElementById('authdlg'); if (!d.open) d.showModal(); }
const BASE = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';

async function api(path, opts={}) {
  path = path.replace(/^\\/+/, '');
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(BASE + path + sep + 'key=' + encodeURIComponent(KEY), opts);
  if (res.status === 401) { showAuth(); throw new Error('unauthorized (key?)'); }
  return res;
}
function esc(s){return s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
// Called once per rendered cell and once per streak step, so it does the YYYY-MM-DD
// formatting directly instead of building an Intl formatter each time.
function fmt(ds){
  const m = ds.getMonth() + 1, d = ds.getDate();
  return ds.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
}
function shiftDay(ds, n){ const d = new Date(ds + 'T12:00:00'); d.setDate(d.getDate() + n); return fmt(d); }

// ---------- offline write queue ----------
const QKEY = 'habitsq';
function qAll(){ try { return JSON.parse(localStorage.getItem(QKEY) || '[]'); } catch { return []; } }
function qSave(q){ localStorage.setItem(QKEY, JSON.stringify(q)); }
function enqueue(path, body){
  const q = qAll();
  const i = q.findIndex(e => e.path === path && JSON.stringify(e.body) === JSON.stringify(body));
  if (i >= 0) q.splice(i, 1); else q.push({ path: path, body: body });
  qSave(q);
}
let flushing = false;
async function flushQ(){
  if (flushing || !navigator.onLine) return;
  if (!qAll().length) return;
  flushing = true;
  try {
    // Drain from the front, re-reading each round. Removing by identity never matched:
    // qAll() re-parses localStorage, so the entries are fresh objects every call, and
    // the queue was replayed in full on every flush — each replay toggling state back.
    while (qAll().length) {
      const e = qAll()[0];
      await api(e.path, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(e.body) });
      qSave(qAll().slice(1));
    }
    load();
  } catch (e2) { /* retry on next tick */ }
  flushing = false;
}
window.addEventListener('online', flushQ);
setInterval(flushQ, 30000);
async function apiWrite(path, body){
  try {
    return await api(path, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  } catch (e) {
    if (!navigator.onLine || (e && e instanceof TypeError)) { enqueue(path, body); return { queued: true }; }
    throw e;
  }
}

let loadTimer = null;
function scheduleLoad(ms){ clearTimeout(loadTimer); loadTimer = setTimeout(load, ms || 400); }
async function toggle(habitId, date){
  const r = await apiWrite('/api/toggle', { habit_id: habitId, date: date });
  if (!r || !r.queued) scheduleLoad();
}
async function skip(habitId, date){
  const r = await apiWrite('/api/skip', { habit_id: habitId, date: date });
  if (!r || !r.queued) scheduleLoad(150);
}

function dateList(){
  const out = [];
  const end = new Date(); end.setHours(12,0,0,0);
  for (let i = N_DAYS-1; i >= 0; i--) { const d = new Date(end); d.setDate(d.getDate()-i); out.push(d); }
  return out;
}

function buildDates(days, todayStr){
  const el = document.getElementById('dates');
  el.style.setProperty('--n', N_DAYS);
  el.classList.toggle('dense', N_DAYS > 14);
  const parts = [];
  for (const d of days) {
    let num = String(d.getDate());
    if (N_DAYS > 14 && d.getDate() === 1) num = (d.getMonth()+1) + '/' + d.getDate();
    parts.push('<div class="dcol' + (fmt(d) === todayStr ? ' today' : '') + '">' +
      '<span class="dow">' + DOW[d.getDay()] + '</span><span class="dnum">' + num + '</span></div>');
  }
  el.innerHTML = parts.join('');
}

function anyLabel(any){
  const names = any.map(function(w){ return DOW[w]; }).join(t('daySep'));
  return names + t('anySuffix');
}
function allLabel(all){
  const names = all.map(function(w){ return DOW[w]; }).join(t('daySep'));
  return names + t('allSuffix');
}

// ---------- render ----------
// Cells no longer carry their own listeners; each cell block records the habit it
// belongs to here, and the delegated handlers below look it up. With a 45-day grid
// that removes five closures per cell in favour of a handful for the whole page.
const CELLCTX = new WeakMap();
let CURRENT = null;
let lastStateJson = null;

// Formatted by hand rather than through Intl.DateTimeFormat. Building that formatter
// pulls in locale data and measured ~75ms on a throttled phone — for one line of text,
// on the critical path. Output matches what the formatter produced:
// "8月25日(火)" / "Tue, August 25".
const MONTHS_EN = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DOW_EN = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function niceDate(){
  const d = new Date();
  if (LANG === 'en') return DOW_EN[d.getDay()] + ', ' + MONTHS_EN[d.getMonth()] + ' ' + d.getDate();
  return (d.getMonth() + 1) + '月' + d.getDate() + '日(' + DOW[d.getDay()] + ')';
}

function render(st) {
  const todayStr = st.today;
  document.getElementById('today-line').textContent = niceDate();
  const days = dateList();
  buildDates(days, todayStr);
  // The rendered window plus a short run-up, as date strings, shared by every habit.
  const LEAD = 5;
  const chain = [];
  for (let i = LEAD; i > 0; i--) { const d = new Date(days[0]); d.setDate(d.getDate() - i); chain.push(fmt(d)); }
  for (const d of days) chain.push(fmt(d));

  // Built into a fragment and attached in one go, so the browser lays out and paints
  // the board once instead of after every habit.
  const frag = document.createDocumentFragment();
  // The ring counts the day's actual targets: the habits whose today cell is lit, i.e.
  // the ones scheduled for today (due_now, the same rule that leaves a cell 'off'
  // below). A habit that isn't scheduled today is nothing to do, so it belongs in
  // neither half of the fraction rather than padding both.
  let done = 0, due = 0;
  if (!st.habits.length) {
    const e = document.createElement('div'); e.className = 'empty';
    e.textContent = t('empty');
    frag.appendChild(e);
  }
  for (const h of st.habits) {
    const color = PALETTE[h.id % PALETTE.length];
    const set = new Set(h.days);
    const skipSet = new Set(h.skips || []);
    const allowed = h.any_days ? new Set(h.any_days) : (h.all_days ? new Set(h.all_days) : null);
    if (h.due_now) { due++; if (h.done_now) done++; }

    const block = document.createElement('div');
    block.className = 'habit';
    block.style.setProperty('--c', color);

    const head = document.createElement('div'); head.className = 'hhead';
    const em = document.createElement('div'); em.className = 'hemoji';
    em.style.background = 'color-mix(in srgb, ' + color + ' 14%, var(--mix))';
    em.textContent = h.emoji || '✨';
    const txt = document.createElement('div'); txt.className = 'htxt';
    txt.innerHTML = '<div class="nm">' + esc(h.name) + '</div>' +
      (h.any_days ? '<div class="sub">' + esc(anyLabel(h.any_days)) + '</div>' :
       (h.all_days ? '<div class="sub">' + esc(allLabel(h.all_days)) + '</div>' : ''));
    const info = document.createElement('button'); info.className = 'hbtn info'; info.textContent = 'ⓘ'; info.title = t('stats');
    info.addEventListener('click', function(){ showStats(h, color); });
    const menu = document.createElement('button'); menu.className = 'hbtn menu'; menu.textContent = '⋮'; menu.title = t('more');
    menu.addEventListener('click', function(e){
      e.stopPropagation();
      const m = document.getElementById('hmenu');
      if (m.classList.contains('open') && menuCtx && menuCtx.id === h.id) { closeMenu(); return; }
      const r = menu.getBoundingClientRect();
      openMenu(h, r.right - 150, r.bottom + 6);
    });
    const btns = document.createElement('div'); btns.className = 'hbtns';
    btns.appendChild(info); btns.appendChild(menu);
    head.appendChild(em); head.appendChild(txt); head.appendChild(btns);
    block.appendChild(head);

    const cells = document.createElement('div');
    cells.className = 'cells' + (N_DAYS > 14 ? ' dense' : '');
    cells.style.setProperty('--n', N_DAYS);
    CELLCTX.set(cells, { h: h, set: set, skipSet: skipSet });
    // One pass over the window carrying the run length forward, rather than walking the
    // streak backwards from every cell. LEAD days of run-up are enough because the heat
    // shade saturates at 5 consecutive days, so a longer true streak cannot shade darker.
    let run = 0;
    const parts = [];
    for (let i = 0; i < chain.length; i++) {
      const ds = chain[i];
      run = set.has(ds) ? run + 1 : 0;
      if (i < LEAD) continue;
      const d = days[i - LEAD];
      const off = allowed && !allowed.has(d.getDay());
      const heat = run ? (run > 4 ? ' on h5' : (run > 1 ? ' on h' + run : ' on')) : '';
      parts.push('<div class="hcell' + (off ? ' off' : '') + (skipSet.has(ds) ? ' skip' : '') +
        (ds === todayStr ? ' today' : '') + heat + '" data-d="' + ds + '"></div>');
    }
    cells.innerHTML = parts.join('');
    block.appendChild(cells);
    frag.appendChild(block);
  }
  document.getElementById('rows').replaceChildren(frag);

  // Nothing due today reads as a finished day, not an empty one.
  const pct = due ? done/due : 1;
  const ring = document.getElementById('ring');
  ring.style.strokeDashoffset = String(150.8 * (1 - pct));
  ring.style.stroke = pct >= 1 ? '#10b981' : '#3b82f6';
  document.getElementById('ring-label').textContent = done + '/' + due;
}

// ---------- delegated cell interaction ----------
const rowsEl = document.getElementById('rows');
function cellOf(e){ const c = e.target.closest && e.target.closest('.hcell'); return c && CELLCTX.get(c.parentNode) ? c : null; }
function doSkip(cell){
  const c = CELLCTX.get(cell.parentNode);
  cell.classList.add('skip'); cell.classList.remove(...HEAT_CLASSES);
  skip(c.h.id, cell.getAttribute('data-d'));
}
rowsEl.addEventListener('click', function(e){
  const cell = cellOf(e);
  if (!cell || cell.classList.contains('skip')) return;
  const c = CELLCTX.get(cell.parentNode);
  if (cell.classList.contains('on')) cell.classList.remove(...HEAT_CLASSES);
  else cell.classList.add('on', 'h5');
  toggle(c.h.id, cell.getAttribute('data-d'));
});
rowsEl.addEventListener('contextmenu', function(e){
  const cell = cellOf(e);
  if (!cell) return;
  e.preventDefault();
  doSkip(cell);
});
let pressTimer = null;
// Passive: the long-press never needs to cancel the gesture, and a non-passive touch
// listener on the board would hold up scrolling.
rowsEl.addEventListener('touchstart', function(e){
  const cell = cellOf(e);
  if (!cell) return;
  pressTimer = setTimeout(function(){ pressTimer = null; doSkip(cell); }, 500);
}, { passive: true });
function cancelPress(){ if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } }
rowsEl.addEventListener('touchend', cancelPress, { passive: true });
rowsEl.addEventListener('touchmove', cancelPress, { passive: true });
// Tooltips are built the first time a cell is actually pointed at. Composing them up
// front meant thousands of strings and streak walks nobody would ever read.
rowsEl.addEventListener('pointerover', function(e){
  const cell = cellOf(e);
  if (!cell || cell.dataset.t) return;
  cell.dataset.t = '1';
  const c = CELLCTX.get(cell.parentNode);
  const ds = cell.getAttribute('data-d');
  const off = cell.classList.contains('off');
  cell.title = ds +
    (cell.classList.contains('skip') ? ' · ' + t('skip')
      : (c.set.has(ds) ? ' · ' + t('streak') + runLen(c.set, ds) + t('day') : '')) +
    (off ? ' · ×' : ' — ' + t('skipHint'));
});

async function load() {
  if (!KEY) { showAuth(); return; }
  let st;
  try {
    st = await (await api('/api/state?days=' + BOOT_DAYS)).json();
  } catch (e) {
    if (!navigator.onLine) {
      if (!CURRENT) document.getElementById('today-line').textContent = t('offline');
      return;
    }
    err(String(e && e.message || e));
    return;
  }
  const j = JSON.stringify(st);
  if (j === lastStateJson) return;   // unchanged — leave the DOM alone
  lastStateJson = j;
  CURRENT = st;
  render(st);
}

// Run lengths for a whole habit in one ascending pass, instead of walking the streak
// backwards from every cell (which was quadratic, and every step built a Date).
const RUNS = new WeakMap();
function runMap(set){
  let m = RUNS.get(set);
  if (m) return m;
  m = new Map();
  for (const ds of [...set].sort()) m.set(ds, (m.get(shiftDay(ds, -1)) || 0) + 1);
  RUNS.set(set, m);
  return m;
}
function runLen(set, ds){ return runMap(set).get(ds) || 0; }
// streak-based heat: 1日=淡い色 → 5日以上=濃い色 (see .hcell.on / .h2-.h5 above)
const HEAT_CLASSES = ['on', 'h2', 'h3', 'h4', 'h5'];

// ---------- emoji picker ----------
const EMOJIS = ['🙂','😄','😊','😌','😍','😎','🥳','😴','💪','🏃','🚶','🧘','🤸','🚴','🏋️','🏊','🧗','🥗','🍎','🥦','🍚','☕','💧','📚','📖','✍️','💻','📝','🎨','🎸','🎹','🎤','🎮','🧠','🧹','🧺','🛏️','🚿','🪥','💊','💰','📈','🌱','☀️','🌙','⭐','🔥','❤️','✅','🎯','📅','⏰','🐾'];
function buildEmojiPicker(){
  const el = document.getElementById('emojipicker');
  const row = document.createElement('div'); row.className = 'erow';
  EMOJIS.forEach(function(e){
    const b = document.createElement('button'); b.type = 'button'; b.textContent = e;
    b.addEventListener('click', function(){ pickEmoji(e); });
    row.appendChild(b);
  });
  el.innerHTML = ''; el.appendChild(row);
}
function pickEmoji(e){
  document.getElementById('emoji-val').value = e;
  document.getElementById('emojibtn').textContent = e;
  document.getElementById('emojipicker').classList.remove('open');
}
let emojiBuilt = false;
function toggleEmoji(){
  // 50-odd buttons that most sessions never open: built on demand, not at startup.
  if (!emojiBuilt) { buildEmojiPicker(); emojiBuilt = true; }
  document.getElementById('emojipicker').classList.toggle('open');
}

function openAdd(){ document.getElementById('adddlg').showModal(); }
function closeAdd(){ document.getElementById('adddlg').close(); }

// ---------- stats popup + overflow menu ----------
function showStats(h, color){
  const dlg = document.getElementById('statsdlg');
  dlg.style.setProperty('--c', color);
  document.getElementById('stats-title').textContent = (h.emoji || '✨') + ' ' + h.name;
  document.getElementById('stats-cur').textContent = h.streak;
  document.getElementById('stats-best').textContent = h.longest;
  document.getElementById('stats-total').textContent = h.total;
  document.getElementById('stats-cur-label').textContent = h.any_days ? t('streakPeriod') : t('streakCur');
  document.getElementById('stats-best-label').textContent = t('bestTitle');
  document.getElementById('stats-total-label').textContent = t('totalTitle');
  dlg.showModal();
}
let menuCtx = null;
function openMenu(h, x, y){
  menuCtx = h;
  const m = document.getElementById('hmenu');
  m.innerHTML = '';
  const b = document.createElement('button');
  b.textContent = t('delete');
  b.className = 'danger';
  b.addEventListener('click', function(){ closeMenu(); doDelete(h.id, h.name); });
  m.appendChild(b);
  m.classList.add('open');
  m.style.left = Math.min(x, window.innerWidth - 170) + 'px';
  m.style.top = Math.min(y, window.innerHeight - 70) + 'px';
}
function closeMenu(){
  document.getElementById('hmenu').classList.remove('open');
  menuCtx = null;
}
function doDelete(id, name){
  if (confirm(t('delConfirm1') + name + t('delConfirm2'))) apiWrite('/api/habits',{op:'delete',id:id}).then(load);
}
// ---------- deferred wiring ----------
// None of this is needed to paint the board: the dialogs are closed and the menu is
// hidden, so it all runs after the first frame is on screen.
function wireDialogs(){
document.addEventListener('click', function(e){
  const m = document.getElementById('hmenu');
  if (m.classList.contains('open') && !m.contains(e.target)) closeMenu();
});

// add dialog: mode + weekday chips
document.querySelectorAll('#modes label').forEach(lab => {
  lab.addEventListener('click', () => {
    document.querySelectorAll('#modes label').forEach(x => x.classList.remove('sel'));
    lab.classList.add('sel');
    const dlg = document.getElementById('adddlg');
    const val = lab.querySelector('input').value;
    dlg.classList.toggle('any', val === 'any');
    dlg.classList.toggle('all', val === 'all');
    if ((val === 'any' || val === 'all') && !document.querySelector('#dows .chip.on')) {
      document.querySelectorAll('#dows .chip').forEach(c => { if ([1,2,3,4,5].indexOf(Number(c.dataset.w)) >= 0) c.classList.add('on'); });
    }
  });
});
document.querySelectorAll('#dows .chip').forEach(chip => {
  chip.addEventListener('click', () => chip.classList.toggle('on'));
});
document.querySelectorAll('.presets .pre').forEach(btn => {
  btn.addEventListener('click', () => {
    const p = btn.dataset.p;
    document.querySelectorAll('#dows .chip').forEach(c => {
      const w = Number(c.dataset.w);
      const on = p === 'all' || (p === 'weekday' && w >= 1 && w <= 5) || (p === 'weekend' && (w === 0 || w === 6));
      c.classList.toggle('on', on);
    });
  });
});

document.getElementById('adddlg').addEventListener('close', e => {
  const dlg = document.getElementById('adddlg');
  if (dlg.returnValue !== 'ok') return;
  const name = dlg.querySelector('input[name=name]').value.trim();
  const emoji = dlg.querySelector('input[name=emoji]').value.trim();
  const mode = dlg.querySelector('input[name=mode]:checked').value;
  dlg.querySelector('input[name=name]').value = '';
  document.getElementById('emoji-val').value = '';
  document.getElementById('emojibtn').textContent = '🙂';
  document.getElementById('emojipicker').classList.remove('open');
  if (!name) return;
  let any = null, all = null;
  if (mode === 'any' || mode === 'all') {
    const sel = [];
    document.querySelectorAll('#dows .chip.on').forEach(c => sel.push(Number(c.dataset.w)));
    if (!sel.length) return;
    if (mode === 'any') any = sel; else all = sel;
  }
  apiWrite('/api/habits', { op:'create', name: name, emoji: emoji, any_days: any, all_days: all }).then(r => {
    if (!r || !r.queued) load();
  });
});
document.getElementById('authdlg').addEventListener('close', e => {
  const inp = document.querySelector('#authdlg input[name=key]');
  if (inp && inp.value.trim()) { KEY = inp.value.trim(); localStorage.setItem('key', KEY); load(); }
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const n = calcDays();
    // Re-render from state already in hand; a resize is not a reason to hit the network.
    if (n !== N_DAYS) { N_DAYS = n; if (CURRENT) render(CURRENT); else load(); }
  }, 200);
});
}

// ---------- boot ----------
applyI18n();
// The server ships the initial state inside this document, so the board is painted
// from data we already have instead of after a round trip to /api/state.
if (window.__STATE__) {
  lastStateJson = window.__STATE__;   // already the exact JSON the server would serve
  CURRENT = JSON.parse(lastStateJson);
  render(CURRENT);
}

requestAnimationFrame(function(){
  setTimeout(function(){
    wireDialogs();
    load();          // revalidate; a no-op re-render when nothing moved
    flushQ();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register(BASE + 'sw.js').catch(function(){});
  }, 0);
});
</script></body></html>`;

// Anonymous shell (no key yet): no state to inline, so it is built and compressed once.
const HTML_ANON = bundle(HTML_SHELL + HTML_APP, 'text/html; charset=utf-8');

function htmlBundle() {
  const sc = stateEntry();
  if (!sc.html) {
    sc.html = bundle(
      HTML_SHELL + '<script>window.__STATE__=' + jsonForScript(JSON.stringify(sliceState(sc.state, BOOT_DAYS))) + '</script>\n' + HTML_APP,
      'text/html; charset=utf-8',
      5
    );
  }
  return sc.html;
}

const server = createServer(async (req, res) => {
  const urlObj = new URL(req.url, 'http://x');
  const p = urlObj.pathname;

  // CORS preflight (Chrome extension fetches cross-origin; preflight carries no auth header)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  // public PWA assets (no auth)
  if (req.method === 'GET' && p.endsWith('/sw.js')) return send(req, res, SW_BUNDLE, REVALIDATE);
  if (req.method === 'GET' && p.endsWith('/manifest.webmanifest')) return send(req, res, MANIFEST_BUNDLE, 'public, max-age=86400');
  if (req.method === 'GET' && p.endsWith('/icon-192.png')) {
    return ICON_192 ? send(req, res, ICON_192, IMMUTABLE) : json(res, 404, { error: 'not found' });
  }
  if (req.method === 'GET' && p.endsWith('/icon-512.png')) {
    return ICON_512 ? send(req, res, ICON_512, IMMUTABLE) : json(res, 404, { error: 'not found' });
  }

  const keyed = authorized(req, urlObj);

  // The app document. When the request is authenticated the state is inlined, so the
  // page renders on arrival with no follow-up round trip.
  if (req.method === 'GET' && p === '/') {
    if (keyed) return send(req, res, htmlBundle(), REVALIDATE, { 'Set-Cookie': SET_COOKIE });
    if (cookieToken(req) === token) return send(req, res, htmlBundle(), REVALIDATE);
    return send(req, res, HTML_ANON, REVALIDATE);
  }

  if (!keyed) return json(res, 401, { error: 'invalid key' });

  if (req.method === 'GET' && p === '/api/health') return json(res, 200, { ok: true });
  if (req.method === 'GET' && p === '/api/state') {
    const n = Number(urlObj.searchParams.get('days'));
    const days = Number.isInteger(n) && n > 0 && n <= 36500 ? n : 0;
    return send(req, res, stateJson(days), REVALIDATE);
  }

  if (req.method === 'POST' && p === '/api/toggle') {
    const b = await body(req);
    const h = Q_HABIT_DAYS.get(b.habit_id);
    if (!h) return json(res, 404, { error: 'habit not found' });
    const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : today();
    const any = h.any_days ? parseAnyDays(JSON.parse(h.any_days)) : null;
    const all = h.all_days ? parseAnyDays(JSON.parse(h.all_days)) : null;
    const sched = any || all;
    if (sched && !sched.includes(new Date(date + 'T12:00:00').getDay())) return json(res, 400, { error: 'not an allowed day for this habit' });
    const exists = Q_CHECKIN_ONE.get(b.habit_id, date);
    if (exists) Q_CHECKIN_DEL.run(b.habit_id, date);
    else Q_CHECKIN_ADD.run(b.habit_id, date);
    invalidateState();
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && p === '/api/skip') {
    const b = await body(req);
    const h = Q_HABIT_DAYS.get(b.habit_id);
    if (!h) return json(res, 404, { error: 'habit not found' });
    const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : today();
    const any = h.any_days ? parseAnyDays(JSON.parse(h.any_days)) : null;
    const all = h.all_days ? parseAnyDays(JSON.parse(h.all_days)) : null;
    const sched = any || all;
    if (sched && !sched.includes(new Date(date + 'T12:00:00').getDay())) return json(res, 400, { error: 'not an allowed day for this habit' });
    const existing = Q_CHECKIN_ONE.get(b.habit_id, date);
    Q_CHECKIN_DEL.run(b.habit_id, date);
    if (!(existing && existing.skip)) {
      Q_SKIP_ADD.run(b.habit_id, date);
    }
    invalidateState();
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && p === '/api/habits') {
    const b = await body(req);
    if (b.op === 'delete' && b.id) {
      Q_HABIT_ARCHIVE.run(b.id);
      invalidateState();
      return json(res, 200, { ok: true });
    }
    const name = (b.name || '').trim();
    if (!name) return json(res, 400, { error: 'name required' });
    const any = parseAnyDays(b.any_days);
    const all = parseAnyDays(b.all_days);
    const r = Q_HABIT_ADD.run(name, (b.emoji||'').trim(), any ? JSON.stringify(any) : null, all ? JSON.stringify(all) : null);
    invalidateState();
    return json(res, 200, { ok: true, id: Number(r.lastInsertRowid) });
  }

  json(res, 404, { error: 'not found' });
});

// Listen only when run directly; importing the file (the tests do) gets the exports
// below without binding a port. import.meta.url is the resolved path, so argv[1] has to
// go through realpath too or a symlinked ExecStart would never start the server.
function isMain() {
  try { return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url; }
  catch { return false; }
}
if (isMain()) {
  // Port 0 asks the OS for a free one, so report the port actually bound rather than
  // the one that was configured.
  server.listen(port, '127.0.0.1', () => console.log(`habit-tracker listening on 127.0.0.1:${server.address().port}`));
}

// The test seam. server.mjs stays the whole app in one file, so the tests reach the
// date math and the database handle through here rather than a second module.
export { db, today, parseAnyDays, getState, sliceState, invalidateState, weekRuns, periodInfo };
