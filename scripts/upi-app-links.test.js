import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../apps/checkout-portal/src/sdk/upi-app-links.js', import.meta.url), 'utf8');
const serverUri = 'upi://pay?pa=shop%40bank&pn=Shop+Name&am=123.45&tn=ORDER-123';
function setup(platform = 'android') {
  const anchors = ['google-pay', 'phonepe', 'paytm', 'cred', 'bhim', 'amazon-pay', 'any'].map(app => ({
    dataset: { upiApp: app }, attributes: {}, listeners: {},
    setAttribute(key, value) { this.attributes[key] = value; },
    getAttribute(key) { return this.attributes[key] ?? null; },
    removeAttribute(key) { delete this.attributes[key]; },
    addEventListener(key, value) { this.listeners[key] = value; }
  }));
  const notice = { textContent: '' };
  const doc = { hidden: false, handlers: {}, querySelectorAll: () => anchors, getElementById: () => notice, addEventListener(key, value) { this.handlers[key] = value; } };
  const navigator = platform === 'android' ? { userAgent: 'Android Chrome', platform: 'Linux armv8', maxTouchPoints: 5 }
    : platform === 'ios' ? { userAgent: 'iPhone', platform: 'iPhone', maxTouchPoints: 5 }
    : { userAgent: 'Windows Chrome', platform: 'Win32', maxTouchPoints: 0 };
  const window = { document: doc, navigator, location: { href: 'https://gateway.example.test/checkout/session-123', search: '' } };
  vm.runInNewContext(source, { window, URL, URLSearchParams });
  return { api: window.YoupiAppLinks, anchors, notice, window, doc };
}

test('Android app links preserve server payment details and target the installed app package', () => {
  const { api } = setup();
  for (const [app, packageName] of [['google-pay','com.google.android.apps.nbu.paisa.user'],['phonepe','com.phonepe.app'],['paytm','net.one97.paytm']]) {
    const intent = api.buildLink(app, serverUri, { platform: 'android', fallbackUrl: 'https://gateway.example.test/checkout/session-123' });
    assert.ok(intent.startsWith('intent://pay?'));
    assert.ok(intent.includes(`package=${packageName};`));
    assert.ok(intent.includes('S.browser_fallback_url=https%3A%2F%2Fgateway.example.test'));
    const query = new URLSearchParams(intent.split('#')[0].split('?')[1]);
    for (const key of ['pa','pn','am','tn']) assert.equal(query.get(key), new URL(serverUri).searchParams.get(key));
    assert.equal(query.get('cu'), 'INR');
  }
  assert.ok(api.buildLink('any', serverUri).startsWith('upi://pay?'));
  assert.ok(api.buildLink('google-pay', serverUri, { platform: 'ios' }).startsWith('gpay://upi/pay?'));
  assert.throws(() => api.buildLink('untrusted-package', serverUri));
  assert.throws(() => api.buildLink('google-pay', 'javascript:alert(1)'));
  assert.throws(() => api.buildLink('google-pay', serverUri.replace('123.45', '0')));
  assert.throws(() => api.buildLink('google-pay', serverUri, { platform: 'android', fallbackUrl: 'javascript:alert(1)' }));
});

test('Android desktop-site mode remains eligible for app handoff', () => {
  const { api } = setup();
  assert.equal(api.detectPlatform({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome', platform: 'Linux armv8l', maxTouchPoints: 5 }), 'android');
  assert.equal(api.detectPlatform({ userAgent: 'desktop', userAgentData: { platform: 'Android' } }), 'android');
  assert.equal(api.detectPlatform({ userAgent: 'X11 Linux', platform: 'Linux x86_64', maxTouchPoints: 0 }), 'desktop');
});

test('A customer tap can navigate immediately; returning refreshes status without declaring payment success', () => {
  const { api, anchors, doc } = setup();
  let state = { status: 'ACTIVE', method: 'UPI', upiUri: serverUri }, refreshes = 0;
  api.init({ getState: () => state, onReturn: () => refreshes++ });
  const gpay = anchors[0];
  assert.ok(gpay.getAttribute('href').includes('package=com.google.android.apps.nbu.paisa.user;'));
  let prevented = false;
  gpay.listeners.click({ preventDefault() { prevented = true; } });
  assert.equal(prevented, false); // Native href executes within this tap, no async launch.
  assert.equal(state.status, 'ACTIVE');
  doc.handlers.visibilitychange();
  assert.equal(refreshes, 1);
  state = { ...state, status: 'EXPIRED' };
  api.update(state);
  assert.equal(gpay.getAttribute('href'), null);
  gpay.listeners.click({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
});

test('Desktop users retain QR fallback and inactive sessions cannot launch stale payment details', () => {
  const { api, anchors, notice } = setup('desktop');
  const state = { status: 'ACTIVE', method: 'UPI', upiUri: serverUri };
  api.init({ getState: () => state });
  let prevented = false;
  anchors[0].listeners.click({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.match(notice.textContent, /phone.*QR/);
  api.update({ ...state, method: 'COD' });
  assert.equal(anchors[0].getAttribute('href'), null);
});
