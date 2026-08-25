// Habit Tracker Gauge — service worker
// Fetches kusaapp state and draws a circular green gauge + count badge in the toolbar.
import { getSettings, apiGet } from './common.js';
import { applyBadge, badgeViewFromState, UNCONFIGURED_VIEW, ERROR_VIEW } from './badge.js';

// Guards against an older, slower /api/state response overwriting a newer one
// when several updates overlap (e.g. rapid toggles in the popup).
let latestUpdate = 0;

async function update() {
  const seq = ++latestUpdate;
  let view;
  try {
    const settings = await getSettings();
    if (!settings.key) {
      view = UNCONFIGURED_VIEW; // not configured yet
    } else {
      view = badgeViewFromState(await apiGet(settings, '/api/state'));
    }
  } catch (e) {
    view = ERROR_VIEW; // unreachable / bad key
  }
  if (seq !== latestUpdate) return; // a newer update already won
  await applyBadge(view);
}

// Paint a view the popup already computed, so the toolbar and the popup can
// never disagree. Bumping the sequence also cancels any in-flight stale fetch.
async function applyView(view) {
  ++latestUpdate;
  await applyBadge(view);
}

function scheduleAlarms() {
  chrome.alarms.create('refresh', { periodInMinutes: 5 });
  const next = new Date();
  next.setHours(24, 0, 0, 0);
  // Repeating: a one-shot midnight alarm would never re-arm itself.
  chrome.alarms.create('midnight', { when: next.getTime(), periodInMinutes: 24 * 60 });
}

chrome.runtime.onInstalled.addListener(() => { update(); scheduleAlarms(); });
chrome.runtime.onStartup.addListener(() => { update(); scheduleAlarms(); });

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === 'refresh') {
    // Return true + sendResponse so Chrome keeps this MV3 worker alive until the
    // badge is actually written; a fire-and-forget handler can be torn down first.
    update().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === 'state' && msg.view) {
    applyView(msg.view).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) update();
});

chrome.alarms.onAlarm.addListener(() => update());

// The worker is torn down when idle and revived by events; refresh and make sure
// the alarms exist on every wake, not only on install/startup.
scheduleAlarms();
update();
