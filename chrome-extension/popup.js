import {
  getSettings, saveSettings, apiGet, apiPost,
  computeProgress, dueToday, dowOf, DEFAULT_URL
} from './common.js';

const DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
let settings = null;
let state = null;

function scheduleLabel(h) {
  if (h.any_days) {
    if (h.any_days.length === 5 && [1, 2, 3, 4, 5].every(d => h.any_days.includes(d))) return 'Any weekday';
    return 'Any of: ' + h.any_days.map(d => DAY_LABELS[d]).join(' ');
  }
  if (h.all_days) {
    if (h.all_days.length === 7) return 'Daily';
    if (h.all_days.length === 5 && [1, 2, 3, 4, 5].every(d => h.all_days.includes(d))) return 'Weekdays';
    if (h.all_days.length === 2 && h.all_days.includes(0) && h.all_days.includes(6)) return 'Weekend';
    return h.all_days.map(d => DAY_LABELS[d]).join(' ');
  }
  return 'Daily';
}

function setConn(text, cls) {
  const el = document.getElementById('connText');
  el.textContent = text;
  el.className = 'conn' + (cls ? ' ' + cls : '');
}

async function load() {
  settings = await getSettings();
  document.getElementById('urlInput').value = settings.url;
  document.getElementById('keyInput').value = settings.key;

  const noKey = !settings.key;
  document.getElementById('setupBox').classList.toggle('hidden', !noKey);
  document.getElementById('habitList').innerHTML = '';
  document.getElementById('emptyState').classList.add('hidden');
  document.getElementById('summaryText').textContent = '';

  if (noKey) { setConn('Set up your server first', 'warn'); return; }

  try {
    state = await apiGet(settings, '/api/state');
    setConn('Connected', 'ok');
    render();
  } catch (e) {
    setConn(e.message === 'unauthorized' ? 'Invalid key' : 'Cannot reach server', 'err');
  }
}

function render() {
  const dow = dowOf(state.today);
  const r = computeProgress(state);
  document.getElementById('summaryText').textContent =
    r.total === 0 ? 'Nothing due today' : `Today ${r.completed}/${r.total} done (${Math.round(r.pct * 100)}%)`;

  const list = document.getElementById('habitList');
  list.innerHTML = '';
  document.getElementById('emptyState').classList.toggle('hidden', state.habits.length > 0);

  for (const h of state.habits) {
    const li = document.createElement('li');
    const isDue = dueToday(h, dow);

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = isDue ? !!h.done_now : false;
    check.disabled = !isDue;
    check.addEventListener('change', async () => {
      await apiPost(settings, '/api/toggle', { habit_id: h.id, date: state.today });
      chrome.runtime.sendMessage({ type: 'refresh' });
      await load();
    });

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = (h.emoji ? h.emoji + ' ' : '') + h.name;
    if (!isDue) name.classList.add('muted');

    const tag = document.createElement('span');
    tag.className = 'tag' + (h.any_days ? ' flexible' : '');
    tag.textContent = scheduleLabel(h);
    if (h.any_days) tag.title = 'any-of-weekday (excluded from gauge)';

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = 'Delete';
    del.addEventListener('click', async () => {
      await apiPost(settings, '/api/habits', { op: 'delete', id: h.id });
      chrome.runtime.sendMessage({ type: 'refresh' });
      await load();
    });

    li.append(check, name, tag, del);
    list.appendChild(li);
  }
}

function readSelectedDays() {
  return [...document.querySelectorAll('#dayPicker input:checked')].map(i => Number(i.value));
}

function setPreset(name) {
  const boxes = [...document.querySelectorAll('#dayPicker input')];
  if (name === 'daily') boxes.forEach(b => (b.checked = true));
  else if (name === 'weekdays') boxes.forEach(b => (b.checked = Number(b.value) >= 1 && Number(b.value) <= 5));
  else if (name === 'weekend') boxes.forEach(b => (b.checked = Number(b.value) === 0 || Number(b.value) === 6));
}

document.querySelectorAll('[data-preset]').forEach(btn => {
  btn.addEventListener('click', () => setPreset(btn.dataset.preset));
});

document.getElementById('addBtn').addEventListener('click', async () => {
  const name = document.getElementById('nameInput').value.trim();
  if (!name) return;
  const flexible = document.getElementById('flexibleInput').checked;
  const days = readSelectedDays();
  let any_days = null, all_days = null;
  if (flexible) {
    any_days = days.length ? days : [1, 2, 3, 4, 5];
  } else {
    all_days = (days.length === 0 || days.length === 7) ? null : days;
  }
  await apiPost(settings, '/api/habits', { op: 'create', name, any_days, all_days });
  document.getElementById('nameInput').value = '';
  document.getElementById('flexibleInput').checked = false;
  chrome.runtime.sendMessage({ type: 'refresh' });
  await load();
});

document.getElementById('saveBtn').addEventListener('click', async () => {
  const url = document.getElementById('urlInput').value.trim() || DEFAULT_URL;
  const key = document.getElementById('keyInput').value.trim();
  await saveSettings({ url, key });
  chrome.runtime.sendMessage({ type: 'refresh' });
  await load();
});

document.getElementById('settingsToggle').addEventListener('click', () => {
  document.getElementById('setupBox').classList.toggle('hidden');
});

document.getElementById('nameInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('addBtn').click();
});

setPreset('daily');
load();
