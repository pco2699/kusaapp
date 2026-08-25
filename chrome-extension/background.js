// Habit Tracker Gauge — service worker
// Draws a circular green gauge icon + count badge in the toolbar.

const TRACK_COLOR = '#1b4332'; // dark green (0% / empty track)
const FILL_COLOR = '#4ade80';  // vivid green (completion fill)

function pad(n) { return String(n).padStart(2, '0'); }

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayOfWeek() {
  return new Date().getDay(); // 0=Sun .. 6=Sat
}

async function getHabits() {
  const { habits = [] } = await chrome.storage.local.get('habits');
  return habits;
}

// A habit counts toward the gauge only if:
//   - it is due today (days includes today's weekday), and
//   - it is not "flexible" (平日どれでも) — those are excluded.
function computeProgress(habits) {
  const today = todayStr();
  const dow = dayOfWeek();
  const due = habits.filter(h => Array.isArray(h.days) && h.days.includes(dow));
  const countable = due.filter(h => !h.flexible);
  const done = countable.filter(h => (h.completedDates || []).includes(today));
  const total = countable.length;
  const completed = done.length;
  const pct = total === 0 ? 1 : completed / total;
  return { completed, total, pct };
}

async function drawGauge(pct, completed, total) {
  const size = 64;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 4;
  const lw = 9;

  ctx.clearRect(0, 0, size, size);

  // Track: full dark green circle
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = TRACK_COLOR;
  ctx.lineWidth = lw;
  ctx.stroke();

  // Fill: bright green arc from 12 o'clock, clockwise
  if (pct > 0) {
    const start = -Math.PI / 2;
    const end = start + Math.PI * 2 * Math.min(1, pct);
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, end);
    ctx.strokeStyle = FILL_COLOR;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  await chrome.action.setIcon({ imageData: ctx.getImageData(0, 0, size, size) });

  // Badge = number of countable habits completed today
  await chrome.action.setBadgeBackgroundColor({ color: '#14532d' });
  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  }
  await chrome.action.setBadgeText({ text: total > 0 ? String(completed) : '' });
}

async function update() {
  const habits = await getHabits();
  const { completed, total, pct } = computeProgress(habits);
  await drawGauge(pct, completed, total);
}

function scheduleMidnightAlarm() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  const delayMin = Math.max(1, Math.round((next - now) / 60000));
  chrome.alarms.create('midnight', { delayInMinutes: delayMin });
}

chrome.runtime.onInstalled.addListener(() => { update(); scheduleMidnightAlarm(); });
chrome.runtime.onStartup.addListener(() => { update(); scheduleMidnightAlarm(); });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.habits) update();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'midnight') {
    update();
    scheduleMidnightAlarm();
  }
});
