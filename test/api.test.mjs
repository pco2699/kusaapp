// The HTTP surface, against a real server process on a real port.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, TOKEN } from './helpers.mjs';

let s;
before(async () => { s = await startServer(); });
after(() => s.stop());

const state = async () => (await fetch(s.url('/api/state'))).json();
const create = (body) => s.post('/api/habits', { op: 'create', ...body });

// Each test builds its own habits; clear the board first so counts stay predictable.
beforeEach(async () => {
  for (const h of (await state()).habits) await s.post('/api/habits', { op: 'delete', id: h.id });
});

describe('auth', () => {
  test('the API rejects a request with no key', async () => {
    const r = await fetch(s.base + '/api/state');
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: 'invalid key' });
  });

  test('the API rejects a wrong key', async () => {
    assert.equal((await fetch(s.base + '/api/state?key=nope')).status, 401);
  });

  test('a bearer token works in place of the query key', async () => {
    const r = await fetch(s.base + '/api/state', { headers: { Authorization: 'Bearer ' + TOKEN } });
    assert.equal(r.status, 200);
  });

  test('writes are rejected without a key', async () => {
    const r = await fetch(s.base + '/api/habits', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'create', name: 'Sneaky' })
    });
    assert.equal(r.status, 401);
    assert.equal((await state()).habits.length, 0, 'nothing was created');
  });

  test('PWA assets are public', async () => {
    for (const p of ['/sw.js', '/manifest.webmanifest']) {
      assert.equal((await fetch(s.base + p)).status, 200, p + ' should not need a key');
    }
  });

  test('the document is served anonymously, without state inlined', async () => {
    const r = await fetch(s.base + '/');
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /<!doctype html>/i);
    // The app script always *reads* window.__STATE__; only the keyed document assigns it.
    assert.ok(!html.includes('window.__STATE__='), 'an unauthenticated visitor gets no data');
  });

  test('a keyed document inlines the state and sets the cookie', async () => {
    const r = await fetch(s.url('/'));
    assert.match(r.headers.get('set-cookie') || '', /kusa_key=.*HttpOnly.*SameSite=Strict/);
    assert.ok((await r.text()).includes('window.__STATE__='));
  });

  test('the cookie serves the document but never the API', async () => {
    const cookie = 'kusa_key=' + encodeURIComponent(TOKEN);
    assert.ok((await (await fetch(s.base + '/', { headers: { cookie } })).text()).includes('window.__STATE__='));
    assert.equal((await fetch(s.base + '/api/state', { headers: { cookie } })).status, 401,
      'a cookie must not authorize cross-site writes');
  });
});

describe('habits', () => {
  test('create returns an id and the habit shows up in the state', async () => {
    const r = await create({ name: 'Read', emoji: '📖' });
    assert.equal(r.status, 200);
    const { id } = await r.json();
    assert.ok(Number.isInteger(id));
    const [h] = (await state()).habits;
    assert.equal(h.id, id);
    assert.equal(h.name, 'Read');
    assert.equal(h.emoji, '📖');
    assert.equal(h.done_now, false);
    assert.deepEqual([h.streak, h.longest, h.total], [0, 0, 0]);
  });

  test('a name is required', async () => {
    const r = await create({ name: '   ' });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: 'name required' });
  });

  test('weekday modes round-trip', async () => {
    await create({ name: 'Running', any_days: [1, 2, 3, 4, 5] });
    await create({ name: 'Worklog', all_days: [1, 5] });
    const habits = (await state()).habits;
    assert.deepEqual(habits.find(h => h.name === 'Running').any_days, [1, 2, 3, 4, 5]);
    assert.deepEqual(habits.find(h => h.name === 'Worklog').all_days, [1, 5]);
  });

  test('junk weekday numbers are dropped, leaving a daily habit', async () => {
    await create({ name: 'Odd', any_days: [9, -2, 'x'] });
    const [h] = (await state()).habits;
    assert.equal(h.any_days, null);
  });

  test('delete archives the habit out of the state', async () => {
    const { id } = await (await create({ name: 'Gone' })).json();
    assert.equal((await s.post('/api/habits', { op: 'delete', id })).status, 200);
    assert.equal((await state()).habits.length, 0);
  });
});

describe('check-ins', () => {
  test('toggle checks today on and back off', async () => {
    const { id } = await (await create({ name: 'Read' })).json();
    assert.equal((await s.post('/api/toggle', { habit_id: id })).status, 200);
    let [h] = (await state()).habits;
    const today = (await state()).today;
    assert.equal(h.done_now, true);
    assert.deepEqual(h.days, [today]);
    assert.equal(h.streak, 1);

    await s.post('/api/toggle', { habit_id: id });
    [h] = (await state()).habits;
    assert.equal(h.done_now, false);
    assert.deepEqual(h.days, []);
  });

  test('an explicit date is honoured', async () => {
    const { id } = await (await create({ name: 'Read' })).json();
    await s.post('/api/toggle', { habit_id: id, date: '2020-02-29' });
    const [h] = (await state()).habits;
    assert.deepEqual(h.days, ['2020-02-29']);
    assert.equal(h.done_now, false, 'a check-in in 2020 says nothing about today');
  });

  test('skip records a skip, and skipping again clears it', async () => {
    const { id } = await (await create({ name: 'Read' })).json();
    await s.post('/api/skip', { habit_id: id });
    let [h] = (await state()).habits;
    assert.deepEqual(h.skips, [(await state()).today]);
    assert.equal(h.total, 0, 'a skip is not a check-in');

    await s.post('/api/skip', { habit_id: id });
    [h] = (await state()).habits;
    assert.deepEqual(h.skips, []);
  });

  test('a day outside a habit’s weekdays is rejected', async () => {
    // 2026-08-30 is a Sunday; this habit only runs on Mondays.
    const { id } = await (await create({ name: 'Monday only', any_days: [1] })).json();
    for (const path of ['/api/toggle', '/api/skip']) {
      const r = await s.post(path, { habit_id: id, date: '2026-08-30' });
      assert.equal(r.status, 400, path);
      assert.deepEqual(await r.json(), { error: 'not an allowed day for this habit' });
    }
    assert.deepEqual((await state()).habits[0].days, []);
  });

  test('an unknown habit is a 404', async () => {
    const r = await s.post('/api/toggle', { habit_id: 999999 });
    assert.equal(r.status, 404);
  });
});

describe('state endpoint', () => {
  test('days=N clips the returned history but not the totals', async () => {
    const { id } = await (await create({ name: 'Read' })).json();
    const today = (await state()).today;
    const old = new Date(today + 'T12:00:00');
    old.setDate(old.getDate() - 300);
    const oldStr = old.toISOString().slice(0, 10);
    await s.post('/api/toggle', { habit_id: id, date: oldStr });
    await s.post('/api/toggle', { habit_id: id });

    const full = await (await fetch(s.url('/api/state'))).json();
    assert.equal(full.habits[0].days.length, 2);
    const clipped = await (await fetch(s.url('/api/state?days=180'))).json();
    assert.deepEqual(clipped.habits[0].days, [today]);
    assert.equal(clipped.habits[0].total, 2);
  });

  test('a nonsense days= value falls back to the full history', async () => {
    const { id } = await (await create({ name: 'Read' })).json();
    await s.post('/api/toggle', { habit_id: id });
    for (const q of ['days=0', 'days=-5', 'days=abc', 'days=99999999']) {
      const j = await (await fetch(s.url('/api/state?' + q))).json();
      assert.equal(j.habits[0].days.length, 1, q);
    }
  });

  test('health check', async () => {
    assert.deepEqual(await (await fetch(s.url('/api/health'))).json(), { ok: true });
  });

  test('an unknown route is a 404', async () => {
    assert.equal((await fetch(s.url('/api/nope'))).status, 404);
  });
});

describe('transport', () => {
  test('a matching ETag revalidates into a 304', async () => {
    await create({ name: 'Read' });
    const first = await fetch(s.url('/api/state'));
    const etag = first.headers.get('etag');
    assert.ok(etag, 'state is served with an ETag');
    const second = await fetch(s.url('/api/state'), { headers: { 'If-None-Match': etag } });
    assert.equal(second.status, 304);
    assert.equal((await second.text()).length, 0);
  });

  test('a write invalidates the cached state', async () => {
    const { id } = await (await create({ name: 'Read' })).json();
    const etag = (await fetch(s.url('/api/state'))).headers.get('etag');
    await s.post('/api/toggle', { habit_id: id });
    const after = await fetch(s.url('/api/state'), { headers: { 'If-None-Match': etag } });
    assert.equal(after.status, 200, 'the old ETag must not match after a check-in');
    assert.equal((await after.json()).habits[0].done_now, true);
  });

  test('the document is compressed when the client asks', async () => {
    const r = await fetch(s.url('/'), { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(r.headers.get('content-encoding'), 'gzip');
    assert.equal(r.headers.get('vary'), 'Accept-Encoding');
  });

  test('CORS preflight is answered without a key', async () => {
    const r = await fetch(s.base + '/api/toggle', { method: 'OPTIONS' });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
  });
});
