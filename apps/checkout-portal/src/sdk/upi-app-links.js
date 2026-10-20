(function (root) {
  'use strict';
  const packages = Object.freeze({
    'google-pay': 'com.google.android.apps.nbu.paisa.user',
    phonepe: 'com.phonepe.app', paytm: 'net.one97.paytm',
    cred: 'com.dreamplug.androidapp', bhim: 'in.org.npci.upiapp',
    'amazon-pay': 'in.amazon.mShop.android.shopping'
  });
  function detectPlatform(nav = {}) {
    const agent = nav.userAgent || '';
    // Chrome's desktop-site mode can hide Android in its UA string.
    if (/Android/i.test(agent) || nav.userAgentData?.platform === 'Android' || (/Linux/i.test(nav.platform || '') && nav.maxTouchPoints > 0)) return 'android';
    if (/iPhone|iPad|iPod/i.test(agent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)) return 'ios';
    return 'desktop';
  }
  function canonicalPaymentUri(value) {
    const uri = new URL(value);
    if (uri.protocol !== 'upi:' || uri.hostname !== 'pay' || (uri.pathname && uri.pathname !== '/') || uri.hash || uri.username || uri.password) throw new Error('Invalid payment URI');
    const amount = uri.searchParams.get('am') || '';
    const payee = uri.searchParams.get('pa') || '';
    if (!/^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z0-9.\-_]{2,64}$/.test(payee) || !/^\d+(\.\d{1,2})?$/.test(amount) || !Number.isFinite(Number(amount)) || Number(amount) <= 0) throw new Error('Payment details are unavailable');
    // Keep all server-supplied payment details; make the INR currency explicit
    // for app handoff without changing the QR payload contract.
    if (uri.searchParams.has('cu') && uri.searchParams.get('cu') !== 'INR') throw new Error('Unsupported currency');
    uri.searchParams.set('cu', 'INR');
    return `upi://pay?${uri.searchParams.toString()}`;
  }
  function buildLink(app, serverUri, options = {}) {
    const uri = canonicalPaymentUri(serverUri);
    if (app === 'any') return uri;
    const packageName = packages[app];
    if (!packageName) throw new Error('Unknown UPI app');
    const query = uri.split('?')[1];
    if (options.platform === 'ios') return app === 'google-pay' ? `gpay://upi/pay?${query}` : uri;
    if (options.platform !== 'android') return uri;
    let fallback = '';
    if (options.fallbackUrl) {
      const url = new URL(options.fallbackUrl);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid fallback URL');
      fallback = `S.browser_fallback_url=${encodeURIComponent(url.href)};`;
    }
    return `intent://pay?${query}#Intent;scheme=upi;package=${packageName};${fallback}end`;
  }
  let getState = () => null;
  function notice(text) {
    const element = root.document?.getElementById('upiAppLaunchHint');
    if (element) element.textContent = text;
  }
  function update(data) {
    const platform = detectPlatform(root.navigator);
    const ready = data?.status === 'ACTIVE' && data.method === 'UPI' && Boolean(data.upiUri);
    for (const anchor of root.document.querySelectorAll('[data-upi-app]')) {
      let href = '';
      if (ready) {
        try {
          const fallback = new URL(root.location.href);
          fallback.hash = '';
          fallback.searchParams.set('upi_fallback', anchor.dataset.upiApp);
          href = buildLink(anchor.dataset.upiApp, data.upiUri, { platform, fallbackUrl: fallback.href });
        } catch {}
      }
      anchor.setAttribute('aria-disabled', href ? 'false' : 'true');
      if (href) anchor.setAttribute('href', href); else anchor.removeAttribute('href');
    }
  }
  function init(options = {}) {
    getState = options.getState || getState;
    for (const anchor of root.document.querySelectorAll('[data-upi-app]')) {
      anchor.addEventListener('click', event => {
        const state = getState();
        if (state?.status !== 'ACTIVE' || state.method !== 'UPI' || anchor.getAttribute('aria-disabled') === 'true') {
          event.preventDefault(); notice('Complete checkout sign-in and wait for your payment session to become active.'); return;
        }
        if (detectPlatform(root.navigator) === 'desktop') {
          event.preventDefault(); notice('Open this payment link on your phone, or scan the QR with your UPI app.'); return;
        }
        // Native anchor navigation runs synchronously within the user's tap.
        // Do not await a fetch, use a timer, or infer payment success from launch.
        notice('Complete payment in your UPI app, then return here for confirmation. If it does not open, try Open UPI app.');
      });
    }
    root.document.addEventListener('visibilitychange', () => {
      if (!root.document.hidden && typeof options.onReturn === 'function') options.onReturn();
    });
    if (root.location.search && new URLSearchParams(root.location.search).has('upi_fallback')) {
      notice('The selected app could not be opened. Try Open UPI app, or open this payment link in Chrome on your phone.');
    }
    update(getState());
  }
  root.YoupiAppLinks = Object.freeze({ buildLink, canonicalPaymentUri, detectPlatform, init, update });
})(typeof window === 'undefined' ? globalThis : window);
