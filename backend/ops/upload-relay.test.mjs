import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import relay from './upload-relay.mjs';

const env = { ORIGIN_URL: 'https://thaituan.site', ALLOWED_ORIGIN: 'https://thaituan.site' };
const id = 'a'.repeat(32);
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const request = (path, options = {}) => new Request(`https://relay.example${path}`, options);

test('rejects foreign browser origins and paths outside the package API', async () => {
  globalThis.fetch = () => { throw new Error('Must not forward'); };
  assert.equal((await relay.fetch(request('/api/apkg/uploads', {
    method: 'POST', headers: { Origin: 'https://attacker.example' },
  }), env)).status, 403);
  assert.equal((await relay.fetch(request('/api/auth/me'), env)).status, 404);
  assert.equal((await relay.fetch(request('/api/apkg/uploads'), env)).status, 405);
  assert.equal((await relay.fetch(request(`/api/apkg/uploads/${id}`), env)).status, 401);
});

test('allows the exact browser preflight, without requiring its bearer token', async () => {
  const response = await relay.fetch(request(`/api/apkg/uploads/${id}?offset=0`, {
    method: 'OPTIONS', headers: { Origin: env.ALLOWED_ORIGIN,
      'Access-Control-Request-Method': 'PUT',
      'Access-Control-Request-Headers': 'authorization,content-type' },
  }), env);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), env.ALLOWED_ORIGIN);
  assert.equal(response.headers.get('Access-Control-Max-Age'), '86400');
});

test('streams the body to the fixed origin, preserving auth and resumable offset', async () => {
  const input = request(`/api/apkg/uploads/${id}?offset=262144`, {
    method: 'PUT', body: 'package chunk', headers: {
      Origin: env.ALLOWED_ORIGIN, Authorization: 'Bearer test-token',
      Cookie: 'unrelated=private', 'Content-Type': 'application/octet-stream',
    },
  });
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), `https://thaituan.site/api/apkg/uploads/${id}?offset=262144`);
    assert.equal(options.body, input.body);
    assert.equal(options.headers.get('Authorization'), 'Bearer test-token');
    assert.equal(options.headers.get('Cookie'), null);
    assert.equal(options.redirect, 'manual');
    return Response.json({ received: 524288 }, { headers: { 'Set-Cookie': 'private=value' } });
  };
  const response = await relay.fetch(input, env);
  assert.deepEqual(await response.json(), { received: 524288 });
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
});

test('returns backend ownership errors with CORS and does not follow redirects', async () => {
  const input = () => request(`/api/apkg/jobs/${id}`, { headers: { Authorization: 'Bearer test-token' } });
  globalThis.fetch = async () => Response.json({ detail: 'Import job not found' }, { status: 404 });
  let response = await relay.fetch(input(), env);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), env.ALLOWED_ORIGIN);
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { Location: 'https://attacker.example' } });
  response = await relay.fetch(input(), env);
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('Location'), null);
});

test('accepts a large bounded chunk and rejects oversized requests before forwarding', async () => {
  let forwarded = 0;
  globalThis.fetch = async () => { forwarded++; return Response.json({ received: 2 * 1024 ** 2 }); };
  const input = length => request(`/api/apkg/uploads/${id}?offset=0`, {
    method: 'PUT', headers: { Authorization: 'Bearer test-token', 'Content-Length': String(length) },
  });
  assert.equal((await relay.fetch(input(2 * 1024 ** 2), env)).status, 200);
  assert.equal((await relay.fetch(input(8 * 1024 ** 2 + 1), env)).status, 413);
  assert.equal(forwarded, 1);
});
