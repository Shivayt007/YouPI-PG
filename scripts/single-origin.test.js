import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGatewayProxy, validateProxyCredentials } from '../apps/gateway-proxy/src/index.js';
import { resolveRuntimeUrls, resolveSingleOriginUrls } from '../packages/common/src/runtime-config.js';

const publicOrigin = 'https://centrallinks-upi.o1wxup.easypanel.host';
test('Single origin uses the supplied hostname and validates configuration', () => {
  const urls = resolveSingleOriginUrls(publicOrigin + '/');
  assert.equal(urls.apiUrl, publicOrigin);
  assert.equal(urls.checkoutUrl, publicOrigin);
  assert.equal(urls.adminUrl, publicOrigin + '/admin');
  assert.equal(urls.routes.length, 3);
  assert.ok(urls.routes.every(route => route.publicHostname === new URL(publicOrigin).host));
  for (const bad of ['http://example.com', 'https://example.com/path', 'https://user:pass@example.com', 'https://example.com/?query=1']) assert.throws(() => resolveSingleOriginUrls(bad));
  assert.throws(() => validateProxyCredentials({ ADMIN_PASSWORD: 'short' }));
  const saved = process.env.PUBLIC_BASE_URL;
  try {
    process.env.PUBLIC_BASE_URL = publicOrigin;
    assert.equal(resolveRuntimeUrls({ envMode: 'production', domain: 'old.example.com' }).apiUrl, publicOrigin);
    assert.equal(resolveRuntimeUrls({ envMode: 'localhost' }).apiUrl, publicOrigin);
  } finally {
    if (saved === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = saved;
  }
});

test('Proxy routes checkout and raw API payloads, gates admin paths, and streams SSE', async t => {
  const servers = [];
  const start = async server => {
    servers.push(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return server.address().port;
  };
  t.after(async () => { await Promise.all(servers.reverse().map(server => new Promise(done => { server.close(done); server.closeAllConnections(); }))); });
  const mock = name => http.createServer((req, res) => {
    if (req.url === '/health') { res.setHeader('Content-Type', 'application/json'); res.end('{"status":"UP"}'); return; }
    if (req.url.endsWith('/stream')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('event: connected\ndata: {}\n\n'); return; }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ service: name, path: req.url, body: Buffer.concat(chunks).toString(), internal: req.headers['x-internal-render'] }));
    });
  });
  const env = {
    PUBLIC_BASE_URL: publicOrigin, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'local-test-password-only',
    PAYMENT_API_PORT: String(await start(mock('api'))),
    CHECKOUT_PORTAL_PORT: String(await start(mock('checkout'))),
    MERCHANT_ADMIN_PORT: String(await start(mock('admin')))
  };
  const base = `http://127.0.0.1:${await start(createGatewayProxy({ env }))}`;
  const auth = 'Basic ' + Buffer.from('admin:local-test-password-only').toString('base64');
  const request = (path, options = {}) => fetch(base + path, { ...options, signal: AbortSignal.timeout(3000) });
  assert.equal((await request('/health')).status, 200);
  for (const path of ['/', '/admin', '/api/v1/admin/merchant-settings', '/api/admin/tickets', '/api/services', '/api/logs/stream', '/api/v1/checkout/id/simulate-observation', '/api/v1/checkout/id/trigger-hook', '/api/v1/checkout/id/expire', '/api/v1/%61dmin/merchant-settings', '/checkout/%2e%2e/api/v1/admin/queue']) {
    assert.equal((await request(path)).status, 401, path);
  }
  const admin = await request('/admin', { headers: { Authorization: auth } });
  assert.equal((await admin.json()).service, 'admin');
  assert.equal((await request('/api/v1/admin/queue', { headers: { Authorization: auth } })).status, 200);
  assert.equal((await request('/api/v1/admin/queue', { method: 'POST', headers: { Authorization: auth, Origin: 'https://untrusted.example' } })).status, 403);
  for (const path of ['/youpi.js', '/checkout/test-id', '/icons/upi.svg']) assert.equal((await (await request(path)).json()).service, 'checkout');
  const raw = '{ "amount": 10,\n "reference": "test-only" }';
  const api = await request('/api/v1/observers/sms?test=1', { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'X-Internal-Render': 'true' } });
  const received = await api.json();
  assert.equal(received.body, raw);
  assert.equal(received.service, 'api');
  assert.equal(received.path, '/api/v1/observers/sms?test=1');
  assert.equal(received.internal, undefined);
  const sse = await request('/api/v1/checkout/test-id/stream');
  assert.equal(sse.headers.get('content-type'), 'text/event-stream');
  const reader = sse.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: connected/);
  await reader.cancel();
});
