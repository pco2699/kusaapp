// Shared client logic for the kusaapp Chrome extension.
export const DEFAULT_URL = 'http://127.0.0.1:8090';

export async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  return {
    url: (settings.url || DEFAULT_URL).replace(/\/+$/, ''),
    key: settings.key || ''
  };
}

export async function saveSettings(s) {
  await chrome.storage.local.set({ settings: { url: s.url, key: s.key } });
}

async function request(path, { method = 'GET', body, settings } = {}) {
  const headers = { 'Authorization': 'Bearer ' + (settings.key || '') };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(settings.url + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

export async function apiGet(settings, path) { return request(path, { settings }); }
export async function apiPost(settings, path, body) { return request(path, { method: 'POST', body, settings }); }

export function dowOf(dateStr) { return new Date(dateStr + 'T12:00:00').getDay(); }

// Is this habit scheduled for the given weekday (0=Sun .. 6=Sat)?
export function dueToday(h, dow) {
  if (h.any_days) return h.any_days.includes(dow);
  if (h.all_days) return h.all_days.includes(dow);
  return true; // daily
}

// Does this habit count toward the toolbar gauge? (any-of-weekday habits do not)
export function countsTowardGauge(h) { return !h.any_days; }

export function computeProgress(state) {
  const dow = dowOf(state.today);
  const due = state.habits.filter(h => countsTowardGauge(h) && dueToday(h, dow));
  const done = due.filter(h => h.done_now);
  const total = due.length;
  const completed = done.length;
  const pct = total === 0 ? 1 : completed / total;
  return { completed, total, pct };
}
