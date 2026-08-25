const DAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

function pad(n) { return String(n).padStart(2, '0'); }
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function dayOfWeek() { return new Date().getDay(); }

async function getHabits() {
  const { habits = [] } = await chrome.storage.local.get('habits');
  return habits;
}
async function saveHabits(habits) {
  await chrome.storage.local.set({ habits });
}

function scheduleLabel(h) {
  if (h.flexible) return '平日どれでも';
  const d = h.days || [];
  if (d.length === 7) return '毎日';
  if (d.length === 5 && !d.includes(0) && !d.includes(6)) return '平日';
  if (d.length === 2 && d.includes(0) && d.includes(6)) return '週末';
  return d.map(i => DAY_LABELS[i]).join('');
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function render() {
  const habits = await getHabits();
  const list = document.getElementById('habitList');
  list.innerHTML = '';
  const today = todayStr();
  const dow = dayOfWeek();

  const due = habits.filter(h => Array.isArray(h.days) && h.days.includes(dow));
  const countable = due.filter(h => !h.flexible);
  const done = countable.filter(h => (h.completedDates || []).includes(today));
  const total = countable.length;
  const completed = done.length;
  const pct = total === 0 ? 1 : completed / total;

  document.getElementById('summaryText').textContent =
    total === 0
      ? '今日の必須タスクはありません'
      : `今日 ${completed}/${total} 完了（${Math.round(pct * 100)}%）`;

  document.getElementById('emptyState').classList.toggle('hidden', habits.length > 0);

  for (const h of habits) {
    const li = document.createElement('li');
    const isDue = Array.isArray(h.days) && h.days.includes(dow);
    const isDone = (h.completedDates || []).includes(today);

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = isDone;
    check.disabled = !isDue;
    check.addEventListener('change', async () => {
      const all = await getHabits();
      const target = all.find(x => x.id === h.id);
      if (!target) return;
      target.completedDates = target.completedDates || [];
      if (check.checked) {
        if (!target.completedDates.includes(today)) target.completedDates.push(today);
      } else {
        target.completedDates = target.completedDates.filter(d => d !== today);
      }
      await saveHabits(all);
      render();
    });

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = h.name;
    if (!isDue) name.classList.add('muted');

    const tag = document.createElement('span');
    tag.className = 'tag' + (h.flexible ? ' flexible' : '');
    tag.textContent = scheduleLabel(h);
    if (h.flexible) tag.title = 'ゲージに換算しない';

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = '削除';
    del.addEventListener('click', async () => {
      const all = await getHabits();
      await saveHabits(all.filter(x => x.id !== h.id));
      render();
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
  let days = readSelectedDays();
  if (days.length === 0) days = [dayOfWeek()];
  const flexible = document.getElementById('flexibleInput').checked;
  const habits = await getHabits();
  habits.push({ id: uid(), name, days, flexible, completedDates: [] });
  await saveHabits(habits);
  document.getElementById('nameInput').value = '';
  document.getElementById('flexibleInput').checked = false;
  render();
});

document.getElementById('nameInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('addBtn').click();
});

setPreset('daily');
render();
