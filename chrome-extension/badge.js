// Toolbar gauge + badge rendering.
// Shared by the service worker and the popup so both write the same numbers:
// whatever the popup shows is exactly what lands on the toolbar icon.
import { computeProgress } from './common.js';

const TRACK_COLOR = '#1b4332'; // dark green (0% / empty track)
const FILL_COLOR = '#4ade80';  // vivid green (completion fill)
const DONE_COLOR = '#14532d';  // badge background, normal state
const IDLE_COLOR = '#64748b';  // badge background, not configured
const ERROR_COLOR = '#b45309'; // badge background, connection error

export const UNCONFIGURED_VIEW = { pct: 0, text: '?', color: IDLE_COLOR };
export const ERROR_VIEW = { pct: 0, text: '!', color: ERROR_COLOR };

// Turn an /api/state payload into what the toolbar should show.
export function badgeViewFromState(state) {
  const { completed, total, pct } = computeProgress(state);
  return { pct, text: total > 0 ? String(completed) : '', color: DONE_COLOR };
}

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

// Paint the toolbar. The gauge and the badge are written independently so a
// failure in one (e.g. OffscreenCanvas/setIcon) can never leave the count stale.
export async function applyBadge(view) {
  const [gauge, badge] = await Promise.allSettled([
    drawGauge(view.pct),
    setBadge(view.text, view.color)
  ]);
  if (gauge.status === 'rejected') console.warn('gauge draw failed', gauge.reason);
  if (badge.status === 'rejected') throw badge.reason;
}
