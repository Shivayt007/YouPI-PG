# EasyPanel Docker deployment

This packages the existing gateway services for a controlled deployment. It does
not connect a merchant storefront or establish production payment readiness.
The upstream services have unauthenticated administration endpoints. The new
single-domain proxy protects these; raw multi-domain deployments still need
external access restrictions.

## Recommended: one generated EasyPanel domain

For `https://centrallinks-upi.o1wxup.easypanel.host` use
`.env.easypanel.single-domain.example`. Set a private `ADMIN_PASSWORD` (at least
12 characters) and a unique `ANDROID_ENROLLMENT_SECRET` in EasyPanel. Preserve
existing encryption/webhook secrets and the `/app/data` volume.

Set the EasyPanel domain's internal protocol to **HTTP** and target port to
**8080**, then redeploy. Leave the start command empty. No root domain,
Cloudflare tunnel or additional subdomains are required. `PUBLIC_BASE_URL`
takes priority over saved legacy domain settings without rewriting the database.

| URL | Purpose |
| --- | --- |
| `/` or `/admin` | Password-protected merchant dashboard |
| `/youpi.js` | Public checkout SDK |
| `/checkout/<payment-id>` | Customer checkout |
| `/api/v1/...` | API and Android observer, on the same hostname |
| `/health` | Aggregated core-service readiness |

The proxy checks HTTP Basic Auth on the dashboard, admin APIs and supervisor
APIs; customers and signed Android observation requests do not need that password.
Administrative simulation/hook endpoints are also protected. HTTPS must stay
enabled at EasyPanel. Do not expose the raw service ports 6001, 6100, 7000 or 8090
through additional domains/host ports: those would bypass the proxy's access gate.
This is a deployment access gate, not a complete security audit of the upstream.

Existing multi-subdomain deployments remain supported when `PUBLIC_BASE_URL`
is absent. Their manual proxy restrictions in the sections below still apply.
The optional Gmail observer and demo store are not exposed in single-domain
mode; start with the native Android observer. Existing hardcoded Gmail OAuth
paths need a separate fix/review before public Gmail use.

After deployment, open `/admin` and enter `ADMIN_USERNAME` / `ADMIN_PASSWORD`.
Set your receiving UPI account, then use the dashboard's SMS Gateway pairing
screen. Its QR payload must show the exact `PUBLIC_BASE_URL`. Pairing and bank
verification are separate from successful HTTP startup. The crackers storefront
still needs order storage and verified webhook integration.

## 1. App service

In EasyPanel create a project and an App service named `gateway`:

- Source: GitHub, repository `Shivayt007/YouPI-PG`, branch `main`.
- Build path: `/`.
- Builder: Dockerfile; file: `Dockerfile`.
- Start command: leave empty (the image starts the production supervisor).
- Replicas: **1**. Do not enable overlapping/zero-downtime deployments for this
  single shared SQLite setup. Back up before upgrades.

The image uses Node 24, installs locked production dependencies with `npm ci`,
runs as the non-root `node` user, and uses Tini for signal forwarding. Chromium,
Java and Android build tools are not installed. Use the native Android observer
for bank alerts; browser-driven Gmail/Google Messages is not provided by this image.

## 2. Environment

Copy `.env.easypanel.example` into EasyPanel's Environment editor. Replace
`example.com` with your root domain in every URL and replace every `CHANGE_ME`
secret. Do not commit a real `.env` or secrets to GitHub. Do not enable EasyPanel's
"Create env file" with the development example: this fork re-reads `.env` inside
child processes, and development values can override production environment values.

`CLOUDFLARE_DOMAIN` is required by the existing production startup. Despite its
name, it is also needed when using EasyPanel's reverse proxy. A Cloudflare tunnel
is not required; leave `CLOUDFLARE_TUNNEL_COMMAND` unset. The canonical URL resolver
uses `DEPLOYMENT_PREFIX=pay` to derive `pay`, `pay-api`, `pay-admin`, `pay-gmail`,
and `pay-store` subdomains. Do not use the earlier generic `api` / `admin` names
unless you also deliberately adapt the runtime URL scheme.

Generate each secret separately on a trusted terminal or in the app shell:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Keep the encryption key and webhook secret stable across redeployments. The
`COIN_STORE_WEBHOOK_SECRET` environment value seeds a new default merchant; it
does not rotate an existing merchant's persisted webhook secret.

## 3. Persistent storage

Add a **Volume** with mount path `/app/data`. Keep the same volume for every
redeployment. It contains the gateway database and WhatsApp session state.

A new Docker volume inherits the image directory's ownership. If using an
existing bind mount, make its directory writable by UID/GID `1000:1000` before
starting; do not fix permission errors with world-writable permissions. Configure
and test backups of this volume. A new empty volume means a new database.

## 4. Domains and access

Create DNS records pointing to your VPS and HTTPS domain routes in EasyPanel:

| Hostname (replace example.com) | Internal protocol | Target port | Access |
| --- | --- | --- | --- |
| `pay.example.com` | HTTP | 7000 | Checkout, after review |
| `pay-api.example.com` | HTTP | 6100 | Public payment routes only; restrict admin paths |
| `pay-admin.example.com` | HTTP | 6001 | Owner-only; protect at proxy |
| `pay-gmail.example.com` | HTTP | 6003 | Optional; configure/review before exposing |
| `pay-store.example.com` | HTTP | 5000 | Optional demo; not the crackers website |

Do not publish host ports. Do not add public routes for port 8090 (supervisor) or
6002 (legacy SMS observer).

**Observed authentication limitation:** `INITIAL_ADMIN_EMAIL`,
`INITIAL_ADMIN_PASSWORD`, and `JWT_SECRET` in the original template are not wired
into admin authentication in this fork. The dashboard, its proxy, and Payment API
`/api/v1/admin/*` routes must be restricted. A password only on the admin hostname
is insufficient if the same admin API remains reachable on the public API host.
Also block administrative APIs reachable through the checkout `/api/` proxy.
EasyPanel app-wide Basic Auth is suitable for an entirely private initial setup;
it will also block customers and observer clients. For public checkout, configure
separate reverse-proxy route rules/access controls, or implement and review
application authentication first. Do not treat this Dockerfile as that security fix.

## 5. Deploy and check

Click Deploy and inspect build/runtime logs. Missing `CLOUDFLARE_DOMAIN` causes
production startup to exit. A healthy container requires all three core services
(API, checkout and admin) to return `status: UP` from `/health`.

From the EasyPanel app shell:

```sh
node scripts/container-healthcheck.js
```

The health check verifies service availability, not bank connectivity or payment
verification. The image build must still be verified on the deployment host;
local Node smoke tests do not replace a Docker build.

## 6. Connect the merchant

1. Open the restricted merchant dashboard.
2. Replace the seeded `merchant@upi` receiver with your intended receiving account.
3. Pair the Android observer using the dashboard and the bank-alert phone.
4. Configure merchant webhook URL and secret for the storefront backend.
5. Implement server-created orders, server-calculated totals, raw-body HMAC
   verification, duplicate-event handling and payment reconciliation.
6. Test a low-value payment, expired checkout, duplicate alerts and restart recovery
   before accepting customer orders.

The storefront currently built in ChatGPT is a catalogue and local shopping list.
Deploying this repository does not automatically connect it or save its orders.

**Gmail limitation:** this fork's Gmail server contains redirects tied to the
original developer's domain. Environment values alone do not repair every OAuth
path. Use Android first; fix and test those URLs before enabling Gmail.
