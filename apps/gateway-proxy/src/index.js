import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest();
const under = (path, prefix) => path === prefix || path.startsWith(prefix + '/');

export function validateProxyCredentials(env = process.env) {
  const username = env.ADMIN_USERNAME || 'admin';
  const password = env.ADMIN_PASSWORD || '';
  if (username.includes(':') || /[\r\n]/.test(username) || password.length < 12 || password.startsWith('CHANGE_ME')) {
    throw new Error('Single-domain mode requires ADMIN_PASSWORD (at least 12 characters) and a valid ADMIN_USERNAME. Set them in EasyPanel Environment.');
  }
  return { username, password };
}

// One public listener; all upstream destinations are fixed loopback services.
// Request/response bodies are streamed unchanged, including HMAC payloads and SSE.
export function createGatewayProxy(options = {}) {
  const env = options.env || process.env;
  const { username, password } = validateProxyCredentials(env);
  const authDigest = digest('Basic ' + Buffer.from(`${username}:${password}`).toString('base64'));
  const origin = new URL(env.PUBLIC_BASE_URL).origin;
  const apiPort = Number(env.PAYMENT_API_PORT || 6100);
  const checkoutPort = Number(env.CHECKOUT_PORTAL_PORT || 7000);
  const adminPort = Number(env.MERCHANT_ADMIN_PORT || 6001);
  const corePorts = [apiPort, checkoutPort, adminPort];

  return http.createServer(async (req, res) => {
    let url, pathname;
    try {
      if (!req.url.startsWith('/') || req.url.startsWith('//')) throw new Error('Invalid path');
      url = new URL(req.url, origin);
      const decoded = decodeURIComponent(url.pathname);
      if (/[\\%]/.test(decoded)) throw new Error('Invalid encoding');
      pathname = new URL(decoded, origin).pathname;
    } catch {
      res.writeHead(400); res.end('Invalid request path'); return;
    }

    if (pathname === '/health' && req.method === 'GET') {
      try {
        await Promise.all(corePorts.map(async port => {
          const check = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
          if (!check.ok || (await check.json()).status !== 'UP') throw new Error('Unavailable');
        }));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ status: 'UP', service: 'single-origin-gateway' }));
      } catch {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ status: 'DOWN', service: 'single-origin-gateway' }));
      }
      return;
    }

    // Browser icons are public. A missing icon must never open an admin login prompt.
    if (['/favicon.ico', '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png'].includes(pathname)) {
      res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' }); res.end(); return;
    }

    const checkoutAsset = pathname === '/youpi.js' || under(pathname, '/sdk') || under(pathname, '/icons');
    const checkoutPage = under(pathname, '/checkout');
    const publicApi = ['/api/v1/payments', '/api/v1/orders', '/api/v1/checkout', '/api/v1/customer', '/api/v1/devices', '/api/v1/observers'].some(prefix => under(pathname, prefix))
      || under(pathname, '/api/v1/pollers/android')
      || pathname === '/api/v1/pollers/heartbeat'
      || pathname === '/api/v1/health';
    // These support/developer actions are never public, even on checkout paths.
    const privilegedCheckout = /\/(simulate-observation|trigger-hook|expire)\/?$/.test(pathname);
    const adminPage = ['/', '/admin', '/admin/', '/payment-link', '/payment-link/'].includes(pathname);
    const adminApi = ['/api/v1/admin', '/api/admin', '/api/services', '/api/logs'].some(prefix => under(pathname, prefix));
    const administrative = adminPage || adminApi || pathname === '/youpi-sms-gateway.apk' || privilegedCheckout;
    if (!(checkoutAsset || checkoutPage || publicApi || administrative)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Route not found'); return;
    }

    if (administrative) {
      const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
      if (!timingSafeEqual(digest(auth), authDigest)) {
        // Challenge only a deliberate admin-page navigation. Fetches/assets must
        // not cause the browser to ask customers for the merchant password.
        const rejectionHeaders = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
        if (adminPage) rejectionHeaders['WWW-Authenticate'] = 'Basic realm="YouPI administration", charset="UTF-8"';
        res.writeHead(401, rejectionHeaders);
        res.end(JSON.stringify({ error: 'Administrator sign-in required' })); return;
      }
      // Basic Auth is browser-ambient; reject cross-origin state changes as well.
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin && req.headers.origin !== origin) {
        res.writeHead(403); res.end('Cross-origin administration is not allowed'); return;
      }
    }

    const adminProxy = under(pathname, '/api/admin') || under(pathname, '/api/services') || under(pathname, '/api/logs');
    const port = checkoutAsset || checkoutPage ? checkoutPort
      : adminProxy ? adminPort
      : under(pathname, '/api') ? apiPort : adminPort;
    const headers = { ...req.headers, host: `127.0.0.1:${port}`, 'x-forwarded-host': new URL(origin).host, 'x-forwarded-proto': new URL(origin).protocol.slice(0, -1) };
    // Do not let clients spoof the upstream's internal-render trust marker.
    delete headers['x-internal-render'];
    if (administrative) delete headers.authorization;
    const upstream = http.request({ hostname: '127.0.0.1', port, path: pathname + url.search, method: req.method, headers }, upstreamRes => {
      const responseHeaders = { ...upstreamRes.headers };
      if (administrative) {
        responseHeaders['cache-control'] = 'no-store';
        delete responseHeaders['access-control-allow-origin'];
      }
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
      res.flushHeaders();
      upstreamRes.pipe(res);
      upstreamRes.on('error', () => res.destroy());
    });
    upstream.on('error', () => {
      if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('Gateway service unavailable'); }
      else res.destroy();
    });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
}

export function startGatewayProxy(options = {}) {
  const env = options.env || process.env;
  const port = Number(env.GATEWAY_PORT || 8080);
  const server = createGatewayProxy(options);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      console.log(`[Single-domain Gateway] Listening on port ${port}`);
      resolve({ server, close: () => new Promise(done => { server.close(done); server.closeAllConnections(); }) });
    });
  });
}
