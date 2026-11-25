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
| Payments | Simulated unless Paypack keys are set: orders marked paid, no money moves | Mobile money through Paypack; without its keys, checkout is disabled |
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

Payments: mobile money (MTN MoMo and Airtel Money) goes through Paypack once
`PAYPACK_CLIENT_ID` and `PAYPACK_CLIENT_SECRET` are set; a live server then also
needs `PAYPACK_WEBHOOK_SECRET` (from the Paypack dashboard, webhook URL
`<PUBLIC_BASE_URL>/api/v1/payments/paypack/webhook`). Only a validly signed
report marks an order paid, and a repeated report changes nothing. Only mobile
money can be chosen for now (`config.payments.enabledMethods`): cards, eKash and
the wallet are refused until they have a provider. While Paypack is connected, a
paid pickup order can't be switched to delivery (its extra fee would need a second
prompt). Without Paypack keys every method is simulated, which only a
development server allows.

## Protections in place

**Sign-in and sessions**
- Admin passwords: 5 wrong passwords lock that email for 30 min, then 2 h, then 24 h (`otpGuardService`, purpose `admin-login`). Unknown emails lock the same way, so the lockout doesn't reveal which accounts exist.
- SMS codes: 5 tries per code, counted atomically; 10 wrong codes in a day lock the phone (30 min → 2 h → 24 h); 20 codes a day per phone (60 for admins). If the SMS gateway fails, the code is cancelled and the user is asked to retry.
- Delivery confirmation codes: 5 wrong codes lock that delivery; support completes it from the admin panel. See "Delivery confirmation codes" below.
- Every public sign-in endpoint: 20 requests a minute per IP.
- Sessions are revocable: sign-out ends that token on the server; "sign out everywhere" (`POST …/logout-all`) and password changes end all others. Admin sessions last 12 h (`ADMIN_JWT_EXPIRES_IN`), others 30 days.
- Admin idle timeout: 30 minutes without use signs an admin session out (`ADMIN_IDLE_TIMEOUT_MINUTES`, 0 = off). The server enforces it (also for closed tabs and copied tokens), and the panel signs itself out and clears the screen after 30 minutes without mouse, keyboard or touch activity.
- An admin still on the seeded password can do nothing but change it.
- Suspended or rejected kitchens and drivers, and deactivated customers and admins, lose access on their next request.

**Requests**
- Per-IP limits: 600 requests a minute for the whole API (`API_RATE_MAX_PER_MINUTE`); 30 a minute for the public delivery price check, which may call the paid Google Routes API (`DELIVERY_QUOTE_RATE_MAX_PER_MINUTE`); plus the sign-in limits above and limits on place search, directions and chat. Kept in memory: fine for one server; several servers would need a shared store (e.g. Redis).
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

## Sign-in with a phone number or an email

The customer, vendor and delivery worker sign-in forms each have one field that takes a phone number or an email address; the server decides which (`utils/identifier.js`: anything with "@" is an email, anything else must be a Rwandan mobile number, written any way: 07…, 2507…, +2507…). The endpoints are unchanged (`/auth/send-otp`, `/vendor/auth/send-otp`, `/driver/auth/send-otp` and their `verify-otp`), with the new body field `identifier` (older `phone_number` / `phone` still work). The account is found by the server, and only an account of that form's kind is signed in; the session's role comes from that account, never from the browser. Vendor and delivery worker sign-in never creates an account.

All codes come from `loginOtpService` with the same rules for SMS and email: 6 random digits stored only as a keyed hash, `OTP_TTL_MINUTES`, single use, 5 tries per code, resend gap, per-window and daily caps, lockouts, and a new code cancels the earlier ones. Codes carry a context, so a phone-change or email-verification code can't be used to sign in.

- **Email codes** go only to the inbox. They are never in an API response, on screen, or in any log (`sendEmail({ sensitive: true })`), on any server. If the email can't be sent, the code is cancelled and the user is told to retry (`EMAIL_NOT_SENT`).
- **SMS codes**: no SMS gateway is connected yet, so a server whose `.env` says `NODE_ENV=development` (or `test`) returns them as `dev_otp` and prints them to its console. Any other server never does: it sends them through `SMS_*`, or refuses with `SMS_NOT_SENT`. Connecting a gateway only means setting `SMS_ENABLED`, `SMS_API_URL` and `SMS_API_KEY` (`utils/sms.js`).
- **Admins** sign in from Customer with their verified phone, then the admin email + password step (below). An admin's email typed in the customer form only ever means a customer account.

## One customer per phone

A customer's `phone_number` is always a phone proven with a code, and is unique among customers in the database (`phone_number_unique_when_set`). Customers who signed up with an email may have none.

- **Phone sign-up / sign-in**: if the number already has a customer account and the name given is a different person's, it is refused with "This phone number is already associated with another customer account. Please use your own phone number or sign in to your existing account." Nothing about the other customer is revealed. Names are compared ignoring case, accents, repeated spaces and word order, but every word must match ("Aline" ≠ "Aline Uwase"). Signing in with no name is an ordinary sign-in: the code to the phone is the proof.
- **Email sign-up**: the phone is optional. If given, it must not be another customer's (same message), nor already have its own account (`PHONE_HAS_ACCOUNT`: that person signs in with the phone and adds the email in their profile). It is kept as `pending_phone_number`, unverified: never used to sign in and never proof of ownership. Its real owner can still register it, and the customer verifies it later from their profile.
- **Changing phone or email** (`POST /auth/me/phone/send-code` then `/verify`; `/auth/me/email/send-code` then `/verify`): the code goes to the new phone or address. The old one stays until it is verified, and another customer's number or address is refused. `PATCH /auth/me/profile` no longer changes them directly (`PHONE_VERIFICATION_REQUIRED`, `EMAIL_VERIFICATION_REQUIRED`). Emails saved before verification existed sign in and receive delivery codes only once verified.
- **Renaming** can't hand over a phone that is also a kitchen's or delivery worker's: the name must stay the one that person registered with.
- **Two sign-ups at the same moment**: the database index decides; the second gets the same refusal (or, if it is the same person, the same account).
- **Existing data**: at start-up, `scripts/migrateCustomerIdentity.js` replaces the old phone index, writes old 07… / 2507… formats as +2507… when the number is used by one customer only, and reports numbers shared by several accounts without changing, merging or moving anything. Run `npm run report:customer-phones` to list them (read only); sort each one out with the customers.
- **Invitations**: an invited admin's phone may also be their own customer phone, but not a customer's under another name.

## Delivery confirmation codes

These are separate from sign-in codes (`deliveryCodeService`; records on the delivery itself).

- **When it's issued**: when the kitchen marks the food ready (at the latest when the rider sets off). There is one code per delivery, stored only as a hash bound to that delivery, so another order's code never matches. It is valid for `DELIVERY_CODE_VALID_HOURS` (12 h).
- **Who receives it**: only the customer, at their verified email, or by SMS once a gateway is connected. It is never in any API response, the customer's or the worker's screens, notifications or logs. A development server may print it to its own console when it couldn't be sent anywhere.
- **Confirming**: only the assigned worker can confirm, with the correct, unexpired code. Five wrong codes lock the delivery for support. The first correct confirmation completes it; it can't be used twice. A status change can never mark an order delivered.
- **New codes**: the customer can ask for one from the order screen ("Send my delivery code": 60 s apart, 5 per delivery). It replaces the old one.
- **No verified email and no SMS**: nothing is skipped. The code still guards the delivery. The customer is told to verify an email and ask again; the worker sees that the customer couldn't receive a code; support can complete it from the admin panel after checking.

## Admin sign-in through the customer phone login

The public "How do you want to sign in?" choice shows only Customer, Vendor and Delivery Worker. Admins sign in from **Customer** with the phone number verified on their admin account (`Admin.phone`, which can only be set by proving the number with an SMS code in Settings → SMS codes), in two stages:

1. **Phone code** — `POST /auth/send-otp` and `POST /auth/verify-otp`, the normal customer sign-in code (same OTP store, expiry, single use, attempt limit, lockout and daily cap). Sending a code behaves identically for every phone, so nobody learns which phones are admins'. Only once the code is verified does the server check whether the phone belongs to an **active** admin (not deactivated, deleted or still invited). If it does, `verify-otp` returns `{ admin_verification_required: true, challenge_token }` and **no session** (no customer and no admin token). Otherwise it is the normal customer sign-in.
2. **Email + password** — `POST /admin/auth/phone-login { challenge_token, email, password }`. The challenge (`AdminLoginChallenge`) is a random token stored as a SHA-256 hash, bound on the server to the admin and the phone, valid 5 minutes, used once, and dropped after 5 wrong attempts. The email and password must belong to **that same admin**; another admin's credentials fail exactly like a wrong password. The email + password lockout of the password sign-in also applies. Success issues the normal admin session (JWT with the admin role, same roles and permissions, idle timeout, sign-out). The verified phone counts as the SMS step of admins who use SMS codes. Successes and failures are written to the admin audit log (`auth.login`, `auth.login_failed`), never with the password.

The role is decided only by the server; the browser never sends one. Every `/admin/*` API checks the admin token and account (`requireAdminAuth`), so a customer token, a challenge token or a forged token is refused. `/admin-login` (email + password, then an SMS code when it is on) still works for admins, but is not linked anywhere.

**One phone, two accounts.** A phone that is both an admin's and a customer's is shown the admin step after the code, with "Continue as a customer instead" (`POST /auth/continue-as-customer { challenge_token }`): it uses the challenge up and signs in to that customer account exactly as before (or creates it, like any first sign-in). Admin and customer records are never merged, linked, converted or changed by this flow.

**Joining the team requires a verified phone.** An invited member opens the emailed link and must, in this order: enter a phone number (`POST /admin/auth/invitations/:token/phone/send-code`, an SMS code with purpose `accept_invite`), prove it with the code (`…/phone/verify`), then create their password (`…/accept`). The server keeps the number the code went to and the verified number on the invitation itself (`invite_phone_pending`, `invite_phone_verified`), never a number sent by the browser at the later steps. `accept` is refused (`PHONE_VERIFICATION_REQUIRED`) until the phone was verified within the last 30 minutes. It then saves that phone and the password hash, turns SMS codes on, and only then makes the account active. No admin session is issued; the member signs in normally afterwards. The usual code limits apply: 30 s between codes, 5 tries per code, the daily cap and lockout. Whether a number already belongs to another admin is only said after its code was verified. A new invitation cancels the old link and any phone progress. Each step is in the audit log (`team.invite_phone_verified`, `team.invite_phone_failed`, `team.invite_accepted`). Members who joined before this change keep their accounts as they are.

**Sign-in codes are stored hashed** (HMAC-SHA256 keyed with the server secret, `utils/otpHash.js`) for every role. Codes created before this change still work until they expire.

## Maintenance

| When | What |
| --- | --- |
| Every start (automatic) | Old verification documents and proof photos move to `private-uploads/`; old card numbers are cut to the last 4 digits; outdated vendor types become current codes; new indexes are built. |
| Once after upgrading to this version | `npm run strip:metadata` removes metadata from photos uploaded before it was stripped automatically. |
| Installing on the server | `npm ci` (exact versions from `package-lock.json`), not `npm install`. |
| Weekly (GitHub) | The *Security audit* workflow runs `npm audit`; Dependabot opens pull requests for updates. Review and merge them. |
| Backups | Back up both databases **and** both `uploads/` and `private-uploads/`. The documents and proof photos exist only there. |

**How long data is kept** is described in [DATA_RETENTION.md](DATA_RETENTION.md)
(a draft: periods still to be confirmed, no automatic deletion yet).

**Unlocking someone early.** Lockouts live in the `otpguards` collection,
keyed `"<purpose>:<phone or email>"`: for example `customer:+250788123456` or
`admin-login:owner@kitchenlink.rw`. Deleting that document lifts the lockout.
