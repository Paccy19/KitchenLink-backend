# Security & going live

How the backend protects itself, what must be set before it can run on a live
server, and the maintenance tasks that come with it. Read this before
deploying, and before changing sign-in, uploads, payments or settings code.

## Development vs live

The server treats itself as a **development server only when `.env` says
`NODE_ENV=development` or `NODE_ENV=test`**. Anything else, including a missing
`NODE_ENV`, counts as live. So a server where someone forgot `NODE_ENV` gets
the strict behaviour, not the relaxed one.

| | Development (`NODE_ENV=development`) | Live (anything else) |
| --- | --- | --- |
| Missing or unsafe settings (below) | Listed as warnings, server starts | **Server refuses to start** and lists them all |
| Sign-in codes and delivery codes | Shown in the API response and console | Never shown; sent by SMS only |
| Payments | Simulated: orders marked paid, no money moves | Checkout disabled until a real provider is connected |
| Public example secrets (`dev-agent-key`, `Admin@12345`) | Accepted | Refused |

## Required on a live server

The startup check (`src/config/startupCheck.js`) refuses to start until all of
these are set:

| Variable | Requirement |
| --- | --- |
| `JWT_SECRET` | Random, 32+ characters. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. Changing it signs everyone out. |
| `MONGODB_URI`, `PG_URI` | Must include a username and password (`mongodb://user:pass@host/db`). Keep both databases off the internet. |
| `AGENT_API_KEY` | Private, 32+ characters. Unlocks the internal endpoints that change order status. |
| `PUBLIC_BASE_URL` | The API's public address, e.g. `https://api.kitchenlink.rw` (photo links are built from it). |
| `FRONTEND_URL` | The website's address, e.g. `https://kitchenlink.rw` (invitation links, CORS). Several addresses: `ALLOWED_ORIGINS`. |
| `SMS_ENABLED`, `SMS_API_URL`, `SMS_API_KEY` | An SMS gateway. Customers, kitchens and drivers sign in with SMS codes; admins confirm money actions with them. |
| `ADMIN_SEED_PASSWORD` | Only when the database has no admin yet: a private password of 12+ characters for the first admin, who must change it at first sign-in. |

Optional (the server starts and prints a reminder): an email service
(`EMAIL_PROVIDER` + `EMAIL_API_KEY`, or `SMTP_*`), `GOOGLE_MAPS_API_KEY`,
`SUPPORT_PHONE` / `SUPPORT_EMAIL`. Behind a hosting proxy or load balancer,
set `TRUST_PROXY=1` so per-IP limits see real visitors.

Payments: every payment method is still simulated (`config.payments.simulated`).
A live server takes no orders until a real provider (e.g. MTN MoMo, Airtel
Money, a gateway) is integrated in `orderService`.

## Protections in place

**Sign-in and sessions**
- Admin passwords: 5 wrong passwords lock that email for 30 min, then 2 h, then 24 h (`otpGuardService`, purpose `admin-login`). Unknown emails lock the same way, so the lockout doesn't reveal which accounts exist.
- SMS codes: 5 tries per code, counted atomically; 10 wrong codes in a day lock the phone (30 min → 2 h → 24 h); 20 codes a day per phone (60 for admins). If the SMS gateway fails, the code is cancelled and the user is asked to retry.
- Delivery confirmation codes: 5 wrong codes lock that delivery; support completes it from the admin panel.
- Every public sign-in endpoint: 20 requests a minute per IP.
- Sessions are revocable: sign-out ends that token on the server; "sign out everywhere" (`POST …/logout-all`) and password changes end all others. Admin sessions last 12 h (`ADMIN_JWT_EXPIRES_IN`), others 30 days.
- An admin still on the seeded password can do nothing but change it.
- Suspended or rejected kitchens and drivers, and deactivated customers and admins, lose access on their next request.

**Requests**
- Helmet security headers; CORS limited to `FRONTEND_URL` / `ALLOWED_ORIGINS`.
- Any body or query containing MongoDB operator keys (`$ne`, `$where`, …) is refused before reaching a route (`rejectOperatorKeys`).
- Clients never see internal error details. Logs hide secrets in URLs (invitation tokens, `?token=` …).

**Files**
- Uploaded files must really be the type they claim (checked by content, not name). Images are re-saved without hidden metadata (EXIF: GPS location, camera, date) and turned the right way up.
- Kitchens' verification documents and delivery proof photos are **private**: stored in `private-uploads/`, never served publicly, opened only through signed-in endpoints. `uploads/` holds the public photos (menus, kitchens, profiles).
- Only the last 4 digits of a card number are ever stored.

**Website** (`frontend/`)
- Production builds include a Content Security Policy (`vite.config.js`): only the site's own scripts run, and connections only go to the API and the map tiles. A new outside service has to be added there, or the browser blocks it.
- The host should also send `Content-Security-Policy: frame-ancestors 'self'` (a `<meta>` tag can't set it).

## Maintenance

| When | What |
| --- | --- |
| Every start (automatic) | Old verification documents and proof photos move to `private-uploads/`; old card numbers are cut to the last 4 digits; outdated vendor types become current codes; new indexes are built. |
| Once after upgrading to this version | `npm run strip:metadata` removes metadata from photos uploaded before it was stripped automatically. |
| Installing on the server | `npm ci` (exact versions from `package-lock.json`), not `npm install`. |
| Weekly (GitHub) | The *Security audit* workflow runs `npm audit`; Dependabot opens pull requests for updates. Review and merge them. |
| Backups | Back up both databases **and** both `uploads/` and `private-uploads/`. The documents and proof photos exist only there. |

**Unlocking someone early.** Lockouts live in the `otpguards` collection,
keyed `"<purpose>:<phone or email>"`: for example `customer:+250788123456` or
`admin-login:owner@kitchenlink.rw`. Deleting that document lifts the lockout.
