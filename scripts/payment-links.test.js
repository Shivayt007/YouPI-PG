import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { Database, runMigrations } from '@youpi/db';
import { createPaymentApp } from '../apps/payment-api/src/index.js';
import { AdminServer } from '../apps/merchant-admin/src/server.js';
import { createGatewayProxy } from '../apps/gateway-proxy/src/index.js';

test('Merchant creates real API-backed links, safely retries, lists saved status, and requires admin access', async t => {
  const before = { PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL, PAYMENT_API_PORT: process.env.PAYMENT_API_PORT };
  const db = new Database({ inMemory: true });
  runMigrations(db);
  const api = createPaymentApp(db);
  const servers = [];
  const start = async server => {
    servers.push(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return server.address().port;
  };
  t.after(async () => {
    api.destroy();
    await Promise.all(servers.reverse().map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
    db.close();
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const apiPort = await start(api.rawServer);
  process.env.PUBLIC_BASE_URL = 'https://gateway.example.test';
  process.env.PAYMENT_API_PORT = String(apiPort);
  const adminPort = await start(new AdminServer({ db }).createServer());
  const checkoutPort = await start(http.createServer((req, res) => res.end('{"status":"UP"}')));
  const env = { ...process.env, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'integration-only-password', MERCHANT_ADMIN_PORT: String(adminPort), CHECKOUT_PORTAL_PORT: String(checkoutPort) };
  const port = await start(createGatewayProxy({ env }));
  const origin = `http://127.0.0.1:${port}`;
  const auth = 'Basic ' + Buffer.from('admin:integration-only-password').toString('base64');
  const call = async (path, data, signed = true) => {
    const response = await fetch(origin + path, {
      method: data ? 'POST' : 'GET', signal: AbortSignal.timeout(5000),
      headers: { ...(signed ? { Authorization: auth } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {})
    });
    const text = await response.text();
    return { status: response.status, text, data: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null };
  };
  assert.equal((await call('/payment-link', null, false)).status, 401);
  assert.equal((await call('/api/admin/payment-links', {}, false)).status, 401);
  assert.equal((await call('/payment-link')).status, 200);
  assert.match((await call('/payment-link')).text, /Create payment link/);
  assert.equal((await call('/api/admin/payment-links')).data.links.length, 0);
  const input = { requestId: crypto.randomUUID(), amount: '123.45', purpose: 'Invoice <test>', customerName: 'Local test customer', status: 'SUCCESS' };
  const noReceiver = await call('/api/admin/payment-links', input);
  assert.equal(noReceiver.status, 400);
  assert.match(noReceiver.data.error, /receiving UPI/);
  // Fixture only: no bank, observer or webhook is contacted by these tests.
  const merchantId = api.context.defaultMerchant.id;
  api.context.accountRepo.create({ merchantId, upiId: 'shop@localtest', payeeName: 'Local test shop', isActive: true });
  for (const amount of ['0', '-1', '1.234', 'NaN', '1000001']) {
    assert.equal((await call('/api/admin/payment-links', { ...input, amount })).status, 400);
  }
  const created = await call('/api/admin/payment-links', input);
  assert.equal(created.status, 201);
  assert.equal(created.data.amount, '123.45');
  assert.equal(created.data.status, 'INITIATED'); // Browser-supplied SUCCESS is ignored.
  assert.equal(created.data.checkoutUrl, `https://gateway.example.test/checkout/${created.data.paymentId}`);
  assert.equal(api.context.sessionRepo.findById(created.data.paymentId).amountPaise, 12345n);
  const retry = await call('/api/admin/payment-links', input);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.paymentId, created.data.paymentId);
  assert.equal((await call('/api/admin/payment-links', { ...input, amount: '124.00' })).status, 409);
  const rows = (await call('/api/admin/payment-links')).data.links;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].purpose, 'Invoice <test>');
  assert.equal(rows[0].customerName, 'Local test customer');
  // Reopening the admin page reconstructs the same saved link from the database.
  assert.equal((await call('/api/admin/payment-links')).data.links[0].checkoutUrl, created.data.checkoutUrl);
  api.context.sessionRepo.transitionToTerminal(created.data.paymentId, 'CANCELLED');
  assert.equal((await call('/api/admin/payment-links')).data.links[0].status, 'CANCELLED');
});
