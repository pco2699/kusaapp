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

describe('service worker updates', () => {
  const sw = async () => (await fetch(s.base + '/sw.js')).text();

  test('the cache name carries a build fingerprint', async () => {
    const src = await sw();
    assert.ok(!src.includes('__ASSET_VERSION__'), 'the placeholder must be substituted');
    assert.match(src, /^const V = 'kusa-[A-Za-z0-9_-]+';/m);
  });

  test('cached PWA responses are partitioned and expired by calendar day', async () => {
    const src = await sw();
    assert.match(src, /function dailyV\(\)/);
    assert.match(src, /const cacheName = dailyV\(\)/);
    assert.match(src, /k !== cacheName[\s\S]*caches\.delete\(k\)/);
    assert.ok(!src.includes('caches.match(req'), 'lookups must not search expired daily caches');
  });

  test('installing does not take over — the new worker waits for the user', async () => {
    const src = await sw();
    const install = src.slice(src.indexOf("addEventListener('install'"), src.indexOf("addEventListener('message'"))
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assert.ok(!install.includes('skipWaiting'), 'the update must not swap in unprompted');
    assert.match(src, /addEventListener\('message'[\s\S]*SKIP_WAITING[\s\S]*skipWaiting\(\)/,
      'the page needs a way to accept the update');
  });

  test('the document offers the update instead of reloading behind the user', async () => {
    const html = await (await fetch(s.base + '/')).text();
    assert.ok(html.includes('id="update-toast"'), 'the prompt is part of the shell');
    assert.match(html, /postMessage\(\{ type: 'SKIP_WAITING' \}\)/);
    // The very first install also fires controllerchange; reloading there would bounce
    // a first-time visitor for nothing — but an accepted update always reloads, even on
    // the page that installed the worker in the first place.
    assert.match(html, /if \(reloading \|\| !\(UPDATE_ACCEPTED \|\| hadController\)\) return;/);
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
    assert.deepEqual([h.total, h.score, h.score_history], [0, 0, []]);
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
    assert.ok(h.score > 0, 'the first check-in puts the strength above 0: ' + h.score);

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

describe('freeze', () => {
  // The API works against the server's own today, so the dates here are relative to it.
  const today = () => state().then(st => st.today);
  const plus = (ds, n) => {
    const d = new Date(ds + 'T12:00:00');
    d.setDate(d.getDate() + n);
    const m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  };
  const freeze = (body) => s.post('/api/freeze', body);
  const first = async () => (await state()).habits[0];

  test('a freeze needs a reason', async () => {
    const { id } = await (await create({ name: 'Gym' })).json();
    const r = await freeze({ habit_id: id, resume_on: plus(await today(), 3) });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: 'reason required' });
    assert.equal((await first()).frozen, false, 'nothing was frozen');
  });

  test('a freeze needs a resume date, and not one in the past', async () => {
    const { id } = await (await create({ name: 'Gym' })).json();
    const t = await today();
    assert.equal((await freeze({ habit_id: id, reason: 'trip' })).status, 400);
    assert.equal((await freeze({ habit_id: id, reason: 'trip', resume_on: 'soon' })).status, 400);
    const past = await freeze({ habit_id: id, reason: 'trip', resume_on: plus(t, -1) });
    assert.equal(past.status, 400);
    assert.deepEqual(await past.json(), { error: 'resume_on must not be in the past' });
    assert.equal((await first()).frozen, false);
  });

  test('freezing parks the habit with its reason and resume date', async () => {
    const { id } = await (await create({ name: 'Gym' })).json();
    const t = await today();
    const r = await freeze({ habit_id: id, reason: '出張のため', resume_on: plus(t, 5) });
    assert.equal(r.status, 200);
    const h = await first();
    assert.equal(h.frozen, true);
    assert.equal(h.freeze.reason, '出張のため');
    assert.equal(h.freeze.resume_on, plus(t, 5));
    assert.equal(h.freeze.since, t, 'the pause starts today');
    assert.equal(h.freeze.resume_due, false);
    assert.equal(h.due_now, false, 'and it is no longer a target for today');
  });

  test('a resume date of today is reported as due right away', async () => {
    const { id } = await (await create({ name: 'Gym' })).json();
    const t = await today();
    await freeze({ habit_id: id, reason: 'trip', resume_on: t });
    assert.equal((await first()).freeze.resume_due, true);
  });

  test('check-ins and skips are refused while the habit is frozen', async () => {
    const { id } = await (await create({ name: 'Gym' })).json();
    await freeze({ habit_id: id, reason: 'trip', resume_on: plus(await today(), 5) });
    for (const p of ['/api/toggle', '/api/skip']) {
      const r = await s.post(p, { habit_id: id });
      assert.equal(r.status, 400, p + ' should be refused');
      assert.deepEqual(await r.json(), { error: 'habit is frozen on that day' });
    }
    assert.equal((await first()).total, 0);
  });

  test('re-freezing edits the running pause instead of stacking a second one', async () => {
    const { id } = await (await create({ name: 'Gym' })).json();
    const t = await today();
    await freeze({ habit_id: id, reason: 'trip', resume_on: plus(t, 5) });
    await freeze({ habit_id: id, reason: 'longer trip', resume_on: plus(t, 12) });
    const h = await first();
    assert.equal(h.freezes.length, 1, 'still one pause');
    assert.equal(h.freeze.since, t, 'which still started when it did');
    assert.equal(h.freeze.reason, 'longer trip');
    assert.equal(h.freeze.resume_on, plus(t, 12));
  });

  test('a habit can be resumed at any time, and the same-day pause leaves no trace', async () => {
    const { id } = await (await create({ name: 'Gym' })).json();
    await freeze({ habit_id: id, reason: 'trip', resume_on: plus(await today(), 9) });
    const r = await freeze({ op: 'unfreeze', habit_id: id });
    assert.equal(r.status, 200);
    const h = await first();
    assert.equal(h.frozen, false);
    assert.equal(h.freeze, null);
    assert.equal(h.due_now, true, 'the habit is a target again');
    assert.deepEqual(h.freezes, [], 'a pause resumed the day it began is not history');
    assert.equal((await s.post('/api/toggle', { habit_id: id })).status, 200, 'and today can be checked in');
  });

  test('a malformed habit id is a 404, not a crash', async () => {
    // node:sqlite throws on a value it cannot bind, and inside the request handler that
    // took the whole server down — every write route has to screen the id first.
    for (const bad of [undefined, null, 'abc', {}, [1], 1.5]) {
      assert.equal((await s.post('/api/freeze', { habit_id: bad, reason: 'trip', resume_on: '2099-01-01' })).status, 404);
      assert.equal((await s.post('/api/toggle', { habit_id: bad })).status, 404);
      assert.equal((await s.post('/api/skip', { habit_id: bad })).status, 404);
      // A delete with no id at all is not a delete; the route falls through to create.
      if (bad) assert.equal((await s.post('/api/habits', { op: 'delete', id: bad })).status, 404);
    }
    assert.deepEqual(await (await fetch(s.url('/api/health'))).json(), { ok: true }, 'the server is still up');
  });

  test('freezing an unknown habit is a 404', async () => {
    const r = await freeze({ habit_id: 999999, reason: 'trip', resume_on: plus(await today(), 2) });
    assert.equal(r.status, 404);
  });
});

describe('habit order', () => {
  const names = async () => (await state()).habits.map(h => h.name);
  const ids = async () => (await state()).habits.map(h => h.id);

  test('habits come back in the order they were added', async () => {
    for (const n of ['A', 'B', 'C']) await create({ name: n });
    assert.deepEqual(await names(), ['A', 'B', 'C']);
  });

  test('a reorder rearranges the board and sticks', async () => {
    for (const n of ['A', 'B', 'C']) await create({ name: n });
    const [a, b, c] = await ids();
    const r = await s.post('/api/habits', { op: 'reorder', ids: [c, a, b] });
    assert.equal(r.status, 200);
    assert.deepEqual(await names(), ['C', 'A', 'B']);
    // and again, from the new order rather than the original one
    await s.post('/api/habits', { op: 'reorder', ids: [a, b, c] });
    assert.deepEqual(await names(), ['A', 'B', 'C']);
  });

  test('a new habit lands after the ones already arranged', async () => {
    for (const n of ['A', 'B']) await create({ name: n });
    const [a, b] = await ids();
    await s.post('/api/habits', { op: 'reorder', ids: [b, a] });
    await create({ name: 'C' });
    assert.deepEqual(await names(), ['B', 'A', 'C'], 'the fresh habit is last, not first');
  });

  test('a reorder with no usable ids is a 400 and changes nothing', async () => {
    for (const n of ['A', 'B']) await create({ name: n });
    for (const bad of [undefined, 'nope', [], ['x', null]]) {
      const r = await s.post('/api/habits', { op: 'reorder', ids: bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.deepEqual(await names(), ['A', 'B']);
  });

  test('a reorder listing only some habits leaves the rest behind it', async () => {
    for (const n of ['A', 'B', 'C']) await create({ name: n });
    const [a, b, c] = await ids();
    // C and B claim the first two slots; A keeps the sort it was created with (0) and,
    // tied with C, falls back to id order — so a partial list never loses a habit.
    await s.post('/api/habits', { op: 'reorder', ids: [c, b] });
    const after = await names();
    assert.equal(after.length, 3, 'every habit is still on the board');
    assert.deepEqual([...after].sort(), ['A', 'B', 'C']);
  });
});
