// Habit Tracker Gauge — service worker
// Fetches kusaapp state and draws a circular green gauge + count badge in the toolbar.
import { getSettings, apiGet, computeProgress } from './common.js';

const TRACK_COLOR = '#1b4332'; // dark green (0% / empty track)
const FILL_COLOR = '#4ade80';  // vivid green (completion fill)

async function drawGauge(pct) {
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
}

async function setBadge(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  await chrome.action.setBadgeText({ text });
}

async function update() {
  let pct = 0;
  let badgeText = '';
  let badgeColor = '#14532d';
  try {
    const settings = await getSettings();
    if (!settings.key) {
      // not configured yet
      badgeText = '?';
      badgeColor = '#64748b';
    } else {
      const state = await apiGet(settings, '/api/state');
      const { completed, total, pct: p } = computeProgress(state);
      pct = p;
      badgeText = total > 0 ? String(completed) : '';
    }
  } catch (e) {
    // unreachable / bad key
    badgeText = '!';
    badgeColor = '#b45309';
  }
  await drawGauge(pct);
  await setBadge(badgeText, badgeColor);
}

function scheduleAlarms() {
  chrome.alarms.create('refresh', { periodInMinutes: 5 });
  const next = new Date();
  next.setHours(24, 0, 0, 0);
  chrome.alarms.create('midnight', { when: next.getTime() });
}

chrome.runtime.onInstalled.addListener(() => { update(); scheduleAlarms(); });
chrome.runtime.onStartup.addListener(() => { update(); scheduleAlarms(); });

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'refresh') update();
  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) update();
});

chrome.alarms.onAlarm.addListener(() => update());
