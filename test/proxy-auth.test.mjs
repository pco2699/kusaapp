// config.proxyAuthHeader: a signing-in reverse proxy vouches for requests with a header.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, TOKEN } from './helpers.mjs';

const HEADER = 'X-Auth-Request-Email';
const signedIn = { [HEADER]: 'me@example.com' };

describe('with proxyAuthHeader set', () => {
  let s;
  before(async () => { s = await startServer({ proxyAuthHeader: HEADER }); });
  after(() => s.stop());

  test('the header alone authorizes the API, reads and writes', async () => {
    assert.equal((await fetch(s.base + '/api/state', { headers: signedIn })).status, 200);
    const r = await fetch(s.base + '/api/habits', {
      method: 'POST', headers: { ...signedIn, 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'create', name: 'Via proxy' })
    });
    assert.equal(r.status, 200);
  });

  test('without the header or a key the API is still closed', async () => {
    assert.equal((await fetch(s.base + '/api/state')).status, 401);
    assert.equal((await fetch(s.base + '/api/state', { headers: { [HEADER]: '' } })).status, 401,
      'an empty value is not a login');
  });

  test('the key keeps working for clients the proxy lets through', async () => {
    const r = await fetch(s.base + '/api/state', { headers: { Authorization: 'Bearer ' + TOKEN } });
    assert.equal(r.status, 200);
  });

  test('a signed-in document inlines the state and hands out no key cookie', async () => {
    const r = await fetch(s.base + '/', { headers: signedIn });
    assert.equal(r.headers.get('set-cookie'), null, 'no key changed hands, so none is stored');
    const html = await r.text();
    assert.ok(html.includes('window.__STATE__='));
    assert.match(html, /const PROXY_AUTH = true;/);
  });
});

describe('without proxyAuthHeader', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(() => s.stop());

  test('the header means nothing', async () => {
    assert.equal((await fetch(s.base + '/api/state', { headers: signedIn })).status, 401);
    const html = await (await fetch(s.base + '/', { headers: signedIn })).text();
    assert.ok(!html.includes('window.__STATE__='));
    assert.match(html, /const PROXY_AUTH = false;/);
  });
});
