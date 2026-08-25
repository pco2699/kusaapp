// Habit Tracker — zero-dependency Node server (node:sqlite built-in)
// API + single-page UI. Auth: ?key= or Authorization: Bearer <token>
// UI: everyday.app-inspired mobile-first layout
// v6 (2026-08-24): any-of-weekday habits, PWA + offline queue
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
const { port, token } = CONFIG;
const DB_PATH = join(ROOT, 'habits.db');

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

function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
}
function dateFmt(dt) {
  return new Intl.DateTimeFormat('en-CA').format(dt);
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function authorized(req, urlObj) {
  const qk = urlObj.searchParams.get('key');
  const auth = req.headers['authorization'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return qk === token || bearer === token;
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
function streakFor(daysSet) {
  let d = new Date();
  const fmt = (dt) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(dt);
  if (!daysSet.has(fmt(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (daysSet.has(fmt(d))) { n++; d.setDate(d.getDate() - 1); }
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
function longestPeriods(keys) {
  const arr = [...keys].map(k => { const p = k.split(':'); return Number(p[0]) * 8 + Number(p[1]); }).sort((a, b) => a - b);
  let best = 0, cur = 0, prev = null;
  for (const o of arr) { cur = (prev !== null && o === prev + 1) ? cur + 1 : 1; prev = o; if (cur > best) best = cur; }
  return best;
}

function getState() {
  const habits = db.prepare('SELECT id, name, emoji, any_days FROM habits WHERE archived=0 ORDER BY sort, id').all();
  const out = [];
  const t = today();
  for (const h of habits) {
    const rows = db.prepare('SELECT date, skip FROM checkins WHERE habit_id=?').all(h.id);
    const checked = rows.filter(r => !r.skip).map(r => r.date);
    const skips = rows.filter(r => r.skip).map(r => r.date);
    let any = null;
    try { any = h.any_days ? parseAnyDays(JSON.parse(h.any_days)) : null; } catch {}
    if (any) {
      const allowed = new Set(any);
      const runs = weekRuns(any);
      const satKeys = new Set(checked.map(ds => { const pi = periodInfo(ds, runs); return pi && pi.key; }).filter(Boolean));
      const skipKeys = new Set(skips.map(ds => { const pi = periodInfo(ds, runs); return pi && pi.key; }).filter(Boolean));
      // done_now: the period relevant to today = first allowed day walking back <= 7 days
      let relKey = null;
      const d = new Date(t + 'T12:00:00');
      for (let i = 0; i < 7; i++) {
        if (allowed.has(d.getDay())) { const pi = periodInfo(dateFmt(d), runs); relKey = pi && pi.key; break; }
        d.setDate(d.getDate() - 1);
      }
      out.push({
        id: h.id, name: h.name, emoji: h.emoji, any_days: any, total: checked.length,
        streak: streakPeriods(satKeys, skipKeys, t, runs, allowed),
        longest: longestPeriods(new Set([...satKeys, ...skipKeys])),
        days: checked, skips,
        done_now: relKey ? satKeys.has(relKey) : false
      });
    } else {
      const union = new Set([...checked, ...skips]);
      out.push({
        id: h.id, name: h.name, emoji: h.emoji, any_days: null, total: checked.length,
        streak: streakFor(union), longest: longestFor(union),
        days: checked, skips, done_now: checked.includes(t)
      });
    }
  }
  return { today: t, habits: out };
}

// ---------- PWA assets ----------
const MANIFEST = JSON.stringify({
  name: 'everyday — habit tracker',
  short_name: 'everyday',
  start_url: './?source=pwa',
  display: 'standalone',
  background_color: '#f6f7fb',
  theme_color: '#f6f7fb',
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
  ]
});

const SW = `const V = 'habits-v1';
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
    e.respondWith(
      caches.match(req, { ignoreSearch: true }).then(m => m || fetch(req).then(r => {
        const cp = r.clone();
        caches.open(V).then(c => c.put(req, cp));
        return r;
      }))
    );
  }
});
`;

function asset(res, file, type) {
  try {
    const data = readFileSync(join(ROOT, file));
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

const HTML = `<!doctype html>
<html lang="ja"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#f6f7fb">
<title>everyday</title>
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icon-192.png">
<link rel="apple-touch-icon" href="icon-192.png">
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin:0 auto; max-width:min(3400px, 96vw); background:#f6f7fb; color:#1c2333; font-family:-apple-system,'Segoe UI',system-ui,sans-serif; padding:20px 18px 120px; }

  .header { display:flex; align-items:center; gap:14px; margin-bottom:16px; padding:0 4px; }
  .logo { font-size:30px; font-weight:800; letter-spacing:-.6px; flex:1; }
  .logo span { color:#10b981; }
  #today-line { color:#8a93a6; font-size:14px; font-weight:500; margin-top:2px; }
  .ringwrap { position:relative; width:64px; height:64px; }
  .ringwrap svg { transform:rotate(-90deg); }
  .ringbg { fill:none; stroke:#e7eaf1; stroke-width:6; }
  #ring { fill:none; stroke:#3b82f6; stroke-width:6; stroke-linecap:round; stroke-dasharray:150.8; stroke-dashoffset:150.8; transition:stroke-dashoffset .5s cubic-bezier(.22,1,.36,1); }
  #ring-label { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-size:14px; font-weight:700; color:#1c2333; }

  .board { background:#fff; border-radius:22px; box-shadow:0 1px 2px rgba(20,30,60,.05), 0 10px 28px rgba(20,30,60,.06); overflow:hidden; }

  .dates { display:grid; grid-template-columns:repeat(var(--n,7), minmax(0,64px)); justify-content:center; gap:6px; padding:14px 14px 10px; border-bottom:1px solid #eef0f5; }
  .dates.dense .dow { display:none; }
  .dates.dense .dcol { gap:2px; }
  .dates.dense .dnum { width:auto; height:auto; font-size:14px; color:#8a93a6; }
  .dates.dense .dcol.today .dnum { width:30px; height:30px; font-size:13.5px; background:#10b981; color:#fff; }
  .dcol { display:flex; flex-direction:column; align-items:center; gap:4px; }
  .dow { font-size:11.5px; color:#a8b0bf; font-weight:600; }
  .dnum { width:34px; height:34px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:15.5px; font-weight:600; color:#1c2333; }
  .dcol.today .dow { color:#10b981; font-weight:700; }
  .dcol.today .dnum { background:#10b981; color:#fff; }

  .habit { padding:14px 14px 16px; border-bottom:1px solid #eef0f5; }
  .habit:last-child { border-bottom:none; }
  .hhead { display:flex; align-items:center; gap:11px; margin-bottom:12px; }
  .hemoji { width:46px; height:46px; border-radius:14px; display:flex; align-items:center; justify-content:center; font-size:23px; flex:none; }
  .htxt { min-width:0; flex:1; }
  .htxt .nm { font-size:17.5px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .htxt .sub { font-size:11.5px; color:#8a93a6; margin-top:2px; font-weight:600; }
  .del { background:none; border:none; color:#d3d8e0; font-size:17px; padding:4px; cursor:pointer; flex:none; align-self:flex-start; }
  .del:hover { color:#ef4444; }

  .badges { display:flex; gap:7px; }
  .badge { width:42px; height:42px; border-radius:50%; display:flex; flex-direction:column; align-items:center; justify-content:center; }
  .badge b { font-size:15.5px; font-weight:800; line-height:1; }
  .badge small { font-size:8.5px; font-weight:600; line-height:1; margin-top:2px; opacity:.8; }
  .badge.cur { background:var(--c); color:#fff; }
  .badge.best { background:color-mix(in srgb, var(--c) 14%, #fff); color:var(--c); }
  .badge.tot { background:#f2f3f8; color:#8a93a6; }

  .cells { display:grid; grid-template-columns:repeat(var(--n,7), minmax(0,80px)); justify-content:center; gap:6px; }
  .cells .hcell { max-height:64px; }
  .cells.dense .hcell { max-height:88px; }
  .hcell { aspect-ratio:1; border-radius:14px; background:#eef0f5; cursor:pointer; transition:transform .1s; }
  .hcell:active { transform:scale(1.15); }
  .hcell.today { box-shadow:0 0 0 2.5px #fff, 0 0 0 4.5px var(--c); }
  .hcell.skip { background-color:#eef0f5; background-image:linear-gradient(to top right, transparent calc(50% - 1.5px), #b8c0cc calc(50% - 1.5px) calc(50% + 1.5px), transparent calc(50% + 1.5px)); }
  .hcell.off { background:transparent; box-shadow:inset 0 0 0 1.5px #f0f1f6; cursor:default; pointer-events:none; }

  .empty { text-align:center; color:#a8b0bf; padding:52px 0; font-size:15px; }
  #err { display:none; background:#fee2e2; color:#b91c1c; border-radius:14px; padding:12px 16px; margin:0 4px 14px; font-size:14px; }

  .addbtn { position:fixed; bottom:22px; left:50%; transform:translateX(-50%);
            background:#1c2333; color:#fff; border:none; border-radius:18px; padding:16px 30px;
            font-size:16px; font-weight:700; cursor:pointer; z-index:10;
            box-shadow:0 6px 18px rgba(20,30,60,.3); }
  .addbtn:active { transform:translateX(-50%) scale(.96); }

  dialog { background:#fff; color:#1c2333; border:none; border-radius:20px; padding:24px; width:min(360px, 88vw);
           box-shadow:0 20px 60px rgba(20,30,60,.25); }
  dialog::backdrop { background:rgba(20,25,40,.4); backdrop-filter:blur(3px); }
  dialog h3 { margin:0 0 16px; font-size:19px; }
  dialog .fld { display:flex; gap:8px; }
  dialog input { background:#f2f3f8; border:none; outline:none; border-radius:13px; padding:13px 14px; font-size:16px; color:#1c2333; }
  dialog input[name=name] { flex:1; }
  dialog input[name=emoji] { width:60px; text-align:center; }
  dialog menu { display:flex; justify-content:flex-end; gap:8px; margin:18px 0 0; padding:0; }
  dialog .ghost { background:none; border:none; color:#8a93a6; font-weight:600; padding:11px 15px; cursor:pointer; font-size:15px; }
  dialog .primary { background:#1c2333; border:none; color:#fff; font-weight:700; border-radius:13px; padding:11px 22px; cursor:pointer; font-size:15px; }

  .modes { display:flex; gap:8px; margin:16px 0 10px; }
  .modes label { flex:1; display:flex; align-items:center; justify-content:center; gap:6px;
                 border:1.5px solid #d3d8e0; border-radius:12px; padding:9px 6px; font-size:13px; font-weight:600; color:#8a93a6; cursor:pointer; }
  .modes label.sel { border-color:#1c2333; background:#1c2333; color:#fff; }
  .modes input { display:none; }
  .dowsel { display:none; }
  dialog.any .dowsel { display:block; }
  .chips { display:flex; gap:6px; justify-content:center; }
  .chip { width:38px; height:38px; border-radius:50%; border:1.5px solid #d3d8e0; background:#fff; color:#8a93a6;
          font-size:13px; font-weight:700; cursor:pointer; }
  .chip.on { background:#10b981; border-color:#10b981; color:#fff; }
  .presets { display:flex; gap:6px; justify-content:center; margin-top:10px; }
  .pre { border:none; background:#f2f3f8; color:#8a93a6; font-size:12px; font-weight:600; border-radius:9px; padding:7px 12px; cursor:pointer; }
</style>
</head><body>
<div class="header">
  <div>
    <div class="logo">every<span>day</span></div>
    <div id="today-line"></div>
  </div>
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

<button class="addbtn" onclick="openAdd()">＋ 新しい習慣</button>

<dialog id="adddlg"><form method="dialog">
  <h3>新しい習慣</h3>
  <div class="fld">
    <input name="emoji" maxlength="4" placeholder="🙂">
    <input name="name" placeholder="習慣の名前">
  </div>
  <div class="modes" id="modes">
    <label class="sel"><input type="radio" name="mode" value="daily" checked>毎日</label>
    <label><input type="radio" name="mode" value="any">選んだ曜日の<br>どれか1回でOK</label>
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

<dialog id="authdlg"><form method="dialog"><p>🔑 アクセスキーを入力</p>
<input name="key" style="width:100%"><menu><button class="primary">OK</button></menu></form></dialog>

<script>
let KEY = localStorage.getItem('key') || new URLSearchParams(location.search).get('key');
if (KEY) localStorage.setItem('key', KEY);

const PALETTE = ['#ff6b6b','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ec4899','#14b8a6','#f97316','#6366f1','#84cc16'];
const DOW = ['日','月','火','水','木','金','土'];

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
function fmt(ds){ return new Intl.DateTimeFormat('en-CA').format(ds); }

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
  const q = qAll();
  if (!q.length) return;
  flushing = true;
  try {
    for (const e of q) {
      await api(e.path, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(e.body) });
      qSave(qAll().filter(x => x !== e));
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
  el.innerHTML = '';
  el.style.setProperty('--n', N_DAYS);
  el.classList.toggle('dense', N_DAYS > 14);
  for (const d of days) {
    const ds = fmt(d);
    const col = document.createElement('div');
    col.className = 'dcol' + (ds === todayStr ? ' today' : '');
    let num = String(d.getDate());
    if (N_DAYS > 14 && d.getDate() === 1) num = (d.getMonth()+1) + '/' + d.getDate();
    col.innerHTML = '<span class="dow">' + DOW[d.getDay()] + '</span><span class="dnum">' + num + '</span>';
    el.appendChild(col);
  }
}

function anyLabel(any){
  const names = any.map(function(w){ return DOW[w]; }).join('・');
  return names + 'のどれか1回';
}

async function load() {
  if (!KEY) { showAuth(); return; }
  let st;
  try {
    st = await (await api('/api/state')).json();
  } catch (e) {
    if (!navigator.onLine) {
      document.getElementById('today-line').textContent = 'オフライン — キャッシュ表示中';
      return;
    }
    err(String(e && e.message || e));
    return;
  }
  const todayStr = st.today;
  const nice = new Intl.DateTimeFormat('ja-JP',{month:'long',day:'numeric',weekday:'short'}).format(new Date());
  document.getElementById('today-line').textContent = nice;
  const days = dateList();
  buildDates(days, todayStr);

  const rows = document.getElementById('rows');
  rows.innerHTML = '';
  let done = 0;
  if (!st.habits.length) {
    const e = document.createElement('div'); e.className = 'empty';
    e.textContent = '🌱 「＋ 新しい習慣」から最初の習慣を追加しよう';
    rows.appendChild(e);
  }
  for (const h of st.habits) {
    const color = PALETTE[h.id % PALETTE.length];
    const set = new Set(h.days);
    const skipSet = new Set(h.skips || []);
    const allowed = h.any_days ? new Set(h.any_days) : null;
    if (h.done_now) done++;

    const block = document.createElement('div');
    block.className = 'habit';
    block.style.setProperty('--c', color);

    const head = document.createElement('div'); head.className = 'hhead';
    const em = document.createElement('div'); em.className = 'hemoji';
    em.style.background = 'color-mix(in srgb, ' + color + ' 14%, #fff)';
    em.textContent = h.emoji || '✨';
    const txt = document.createElement('div'); txt.className = 'htxt';
    txt.innerHTML = '<div class="nm">' + esc(h.name) + '</div>' +
      (h.any_days ? '<div class="sub">' + esc(anyLabel(h.any_days)) + '</div>' : '');
    const badges = document.createElement('div'); badges.className = 'badges';
    const sTitle = h.any_days ? '連続達成期間' : '現在のストリーク';
    badges.innerHTML =
      '<div class="badge cur" title="' + sTitle + '"><b>' + h.streak + '</b><small>cur</small></div>' +
      '<div class="badge best" title="最長"><b>' + h.longest + '</b><small>best</small></div>' +
      '<div class="badge tot" title="累計"><b>' + h.total + '</b><small>total</small></div>';
    const del = document.createElement('button'); del.className = 'del'; del.textContent = '✕'; del.title = '削除';
    del.onclick = () => { if (confirm('「'+h.name+'」を削除？')) apiWrite('/api/habits',{op:'delete',id:h.id}).then(load); };
    head.appendChild(em); head.appendChild(txt); head.appendChild(badges); head.appendChild(del);
    block.appendChild(head);

    const cells = document.createElement('div');
    cells.className = 'cells' + (N_DAYS > 14 ? ' dense' : '');
    cells.style.setProperty('--n', N_DAYS);
    for (const d of days) {
      const ds = fmt(d);
      const isSkip = skipSet.has(ds);
      const off = allowed && !allowed.has(d.getDay());
      const cell = document.createElement('div');
      cell.className = 'hcell' + (off ? ' off' : '') + (isSkip ? ' skip' : '') + (ds === todayStr ? ' today' : '');
      if (set.has(ds)) cell.style.background = heatColor(color, set, ds);
      cell.title = ds + (isSkip ? ' · スキップ' : (set.has(ds) ? ' · 連続' + runLen(set, ds) + '日' : '')) + (off ? ' · ×' : ' — 長押し/右クリックでスキップ');
      let pressTimer = null;
      cell.onclick = () => {
        if (cell.classList.contains('skip')) return;
        const on = !cell.style.background;
        cell.style.background = on ? color : '';
        toggle(h.id, ds);
      };
      const startSkip = (e) => {
        e.preventDefault(); e.stopPropagation();
        cell.classList.add('skip'); cell.style.background = '';
        skip(h.id, ds);
      };
      cell.oncontextmenu = startSkip;
      cell.ontouchstart = () => {
        pressTimer = setTimeout(function(){ pressTimer = null; startSkip({ preventDefault:function(){}, stopPropagation:function(){} }); }, 500);
      };
      cell.ontouchend = cell.ontouchmove = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
      cells.appendChild(cell);
    }
    block.appendChild(cells);
    rows.appendChild(block);
  }

  const total = st.habits.length;
  const pct = total ? done/total : 0;
  document.getElementById('ring').style.strokeDashoffset = String(150.8 * (1 - pct));
  document.getElementById('ring').style.stroke = pct >= 1 ? '#10b981' : '#3b82f6';
  document.getElementById('ring-label').textContent = done + '/' + total;
}

function runLen(set, ds){
  let n = 0; const d = new Date(ds + 'T12:00:00');
  while (set.has(fmt(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
// streak-based heat: 1日=淡い色 → 5日以上=濃い色
function heatColor(color, set, ds){
  const run = runLen(set, ds);
  const pct = Math.min(100, 40 + (run - 1) * 15);
  return 'color-mix(in srgb, ' + color + ' ' + pct + '%, #fff)';
}

function openAdd(){ document.getElementById('adddlg').showModal(); }
function closeAdd(){ document.getElementById('adddlg').close(); }

// add dialog: mode + weekday chips
document.querySelectorAll('#modes label').forEach(lab => {
  lab.addEventListener('click', () => {
    document.querySelectorAll('#modes label').forEach(x => x.classList.remove('sel'));
    lab.classList.add('sel');
    const dlg = document.getElementById('adddlg');
    const any = lab.querySelector('input').value === 'any';
    dlg.classList.toggle('any', any);
    if (any && !document.querySelector('#dows .chip.on')) {
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
  dlg.querySelector('input[name=name]').value = ''; dlg.querySelector('input[name=emoji]').value = '';
  if (!name) return;
  let any = null;
  if (mode === 'any') {
    any = [];
    document.querySelectorAll('#dows .chip.on').forEach(c => any.push(Number(c.dataset.w)));
    if (!any.length) return;
  }
  apiWrite('/api/habits', { op:'create', name: name, emoji: emoji, any_days: any }).then(r => {
    if (!r || !r.queued) load();
  });
});
document.getElementById('authdlg').addEventListener('close', e => {
  const inp = document.querySelector('#authdlg input[name=key]');
  if (inp && inp.value.trim()) { KEY = inp.value.trim(); localStorage.setItem('key', KEY); load(); }
});

// service worker (PWA + offline cache)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(BASE + 'sw.js').catch(function(){});
}
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const n = calcDays();
    if (n !== N_DAYS) { N_DAYS = n; load(); }
  }, 200);
});
flushQ();
load();
</script></body></html>`;

const server = createServer(async (req, res) => {
  const urlObj = new URL(req.url, 'http://x');
  const p = urlObj.pathname;

  // public PWA assets (no auth)
  if (req.method === 'GET' && p.endsWith('/sw.js')) {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(SW);
  }
  if (req.method === 'GET' && p.endsWith('/manifest.webmanifest')) {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' });
    return res.end(MANIFEST);
  }
  if (req.method === 'GET' && p.endsWith('/icon-192.png')) return asset(res, 'icon-192.png', 'image/png');
  if (req.method === 'GET' && p.endsWith('/icon-512.png')) return asset(res, 'icon-512.png', 'image/png');

  if (!authorized(req, urlObj)) {
    if (p === '/' && req.method === 'GET') { res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); return res.end(HTML); }
    return json(res, 401, { error: 'invalid key' });
  }

  if (req.method === 'GET' && p === '/') { res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); return res.end(HTML); }
  if (req.method === 'GET' && p === '/api/health') return json(res, 200, { ok: true });
  if (req.method === 'GET' && p === '/api/state') return json(res, 200, getState());

  if (req.method === 'POST' && p === '/api/toggle') {
    const b = await body(req);
    const h = db.prepare('SELECT any_days FROM habits WHERE id=? AND archived=0').get(b.habit_id);
    if (!h) return json(res, 404, { error: 'habit not found' });
    const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : today();
    const any = h.any_days ? parseAnyDays(JSON.parse(h.any_days)) : null;
    if (any && !any.includes(new Date(date + 'T12:00:00').getDay())) return json(res, 400, { error: 'not an allowed day for this habit' });
    const exists = db.prepare('SELECT 1 FROM checkins WHERE habit_id=? AND date=?').get(b.habit_id, date);
    if (exists) db.prepare('DELETE FROM checkins WHERE habit_id=? AND date=?').run(b.habit_id, date);
    else db.prepare('INSERT INTO checkins (habit_id, date) VALUES (?, ?)').run(b.habit_id, date);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && p === '/api/skip') {
    const b = await body(req);
    const h = db.prepare('SELECT any_days FROM habits WHERE id=? AND archived=0').get(b.habit_id);
    if (!h) return json(res, 404, { error: 'habit not found' });
    const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : today();
    const any = h.any_days ? parseAnyDays(JSON.parse(h.any_days)) : null;
    if (any && !any.includes(new Date(date + 'T12:00:00').getDay())) return json(res, 400, { error: 'not an allowed day for this habit' });
    const existing = db.prepare('SELECT skip FROM checkins WHERE habit_id=? AND date=?').get(b.habit_id, date);
    db.prepare('DELETE FROM checkins WHERE habit_id=? AND date=?').run(b.habit_id, date);
    if (!(existing && existing.skip)) {
      db.prepare('INSERT INTO checkins (habit_id, date, skip) VALUES (?, ?, 1)').run(b.habit_id, date);
    }
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && p === '/api/habits') {
    const b = await body(req);
    if (b.op === 'delete' && b.id) {
      db.prepare('UPDATE habits SET archived=1 WHERE id=?').run(b.id);
      return json(res, 200, { ok: true });
    }
    const name = (b.name || '').trim();
    if (!name) return json(res, 400, { error: 'name required' });
    const any = parseAnyDays(b.any_days);
    const r = db.prepare('INSERT INTO habits (name, emoji, any_days) VALUES (?, ?, ?)').run(name, (b.emoji||'').trim(), any ? JSON.stringify(any) : null);
    return json(res, 200, { ok: true, id: Number(r.lastInsertRowid) });
  }

  json(res, 404, { error: 'not found' });
});

server.listen(port, '127.0.0.1', () => console.log(`habit-tracker listening on 127.0.0.1:${port}`));
