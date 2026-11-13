# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The reference backend for KitchenLink, a multi-vendor food marketplace in Rwanda. It answers every request in `../KitchenLink-frontend/API_CONTRACT.md`, which the website and the Flutter apps (`../KitchenLink-Mobile`) also follow. Node 18+, Express 5, Mongoose, CommonJS.

## Commands

```bash
npm install && cp .env.example .env     # first time
npm run dev                             # nodemon → http://localhost:4000/api/v1
npm start
npm test                                # node --test "test/**/*.test.js"
node --test test/unit/pricing.test.js   # one file
node --test --test-name-pattern="fee ranges" test/unit/pricing.test.js   # one test
TEST_VERBOSE=1 npm test                 # show server request logs
```

There is no linter or build step.

- `test/unit/` covers pure logic (pricing, deposits, fee ranges, validators).
- `test/api/` runs the real app against MongoDB, which must be running locally (`TEST_MONGODB_SERVER` picks another server). Each file gets its own database `kitchenlink_<pid>_test`, which is dropped afterwards. `test/helpers/testServer.js` refuses any database whose name doesn't end in `_test`. It also sets `NODE_ENV=test` and turns off SMS, email, Google Maps and real payouts before loading `src/`.

Seeding and maintenance:
- Seed demo data: `seed:admin`, `seed:categories`, `seed:drivers` (demo drivers 0788100001–004).
- Postgres mirror: `migrate:pg` then `seed:pg`.
- One-off fixes: `migrate:vendors`, `migrate:vendor-types`, `strip:metadata`.

## Architecture

Requests flow **routes → controllers → services → repositories → models**:
- `src/routes/index.js` mounts everything under `/api/v1`.
- Controllers are thin `asyncHandler` wrappers.
- Business rules live in `src/services/`.
- Mongo queries live in `src/repositories/`.
- Mongoose schemas live in `src/models/` (snake_case fields).

Throw `ApiError` (`src/utils/ApiError.js`). `middleware/errorHandler.js` turns it, and Mongoose, Cast and Multer errors, into the `{ error: { code, message, details } }` shape, and never sends internal messages to clients.

**Boot (`src/server.js`) does a lot.** It runs the startup check, connects MongoDB and then Postgres, seeds the admin and the global commission, migrates the legacy ledger and checks it balances, normalises vendor types, masks card numbers, and moves old documents into `private-uploads/`. It loads the admin-editable settings (delivery, bank, delivery fee and dispatch settings services) and starts the background schedulers: `platformSweepService`, `vendorOfferService`, `eventBalanceService` and `deliveryService.start()`. `src/app.js` builds the Express app without listening, which is what the tests import.

**Development vs live.** Only `NODE_ENV=development` or `test` counts as development (`config.explicitDev`). Anything else, including no `NODE_ENV`, is live:
- `src/config/startupCheck.js` refuses to start a live server until the required settings are set (`JWT_SECRET`, credentials in the DB URIs, `AGENT_API_KEY`, the public URLs, SMS).
- In development, OTP and delivery codes come back in responses (`dev_otp`).
- Mobile money goes through Paypack (`services/paypackService.js`) once its keys are set: checkout leaves the order `pending`, and Paypack's signed webhook (`POST /payments/paypack/webhook`) or the app's poll (`POST /orders/:id/payment/check`) settles it through `orderService.settleProviderPayment`, which runs the same paid steps (`#announcePaid`, settlement) as an instant payment. Without the keys payments are simulated (`config.payments.simulated`), and a live server takes no orders.
- Read `SECURITY.md` before touching sign-in, sessions, uploads, payments or settings code.

**Settings.** `src/config/index.js` reads `.env`. Many delivery and dispatch values there are only starting values: once an admin saves Settings, the `*SettingsService` loaded at boot supplies the saved values.

**Order and delivery state machines.** Allowed transitions live in `config` (vendor transitions near `transitions` in `src/config/index.js`, delivery transitions under `config.delivery.transitions`) and are returned to clients as `allowed_next_statuses`.
- The vendor statuses are a translation over the customer order statuses (`new→placed`, `accepted→confirmed`, `completed→delivered`), so it's one Order record, not two.
- Vendors never complete an order. It completes only when a driver confirms the customer's code (`POST /driver/deliveries/:id/confirm-delivery`). That step credits the vendor's balance net of commission and pays the driver.
- Marking an order `ready` auto-creates a Delivery and dispatches it to nearby online drivers (`$geoNear`). The first driver to accept wins atomically (`findOneAndUpdate` with `driver_id: null`).
- Once a driver accepts, nobody can cancel (`409 DELIVERY_IN_PROGRESS`). Details are in `DELIVERY.md`.

**Money.** All amounts are integer RWF (`*_rwf`). Commission comes from the food subtotal only, never the delivery fee. Drivers keep the delivery fee (`DELIVERY_DRIVER_SHARE_PERCENT`), minus the late-pickup penalty. A double-entry style platform ledger (`platformLedgerService`) is checked at boot and must balance.

**PostgreSQL is a read-only mirror.** MongoDB is the source of truth, and application code never reads or writes Postgres. `src/db/postgres.js` only checks the connection at boot (a warning if it's down, never fatal). The mirror changes only through `npm run migrate:pg`, a full drop-and-recopy with parity verification that needs a superuser, or `seed:pg`. `postgres/schema.sql` holds the DDL. A Mongo schema change needs a matching edit to `schema.sql` and to `src/scripts/migratePostgres.js`. Re-run `migrate:pg` after customer erasures (`DATA_RETENTION.md`).

**Security plumbing that applies to every request.**
- `rejectOperatorKeys` refuses any body or query containing `$` operator keys.
- Per-IP rate limits are kept in memory (one server only).
- Auth middleware comes in per role: `requireAuth` (customer), `requireVendorAuth` + `requireApprovedVendor`, `requireDriverAuth`, and `requireAdminAuth` + `requirePermission` / `requireSuperAdmin`.
- Sessions can be revoked (the `revokedtokens` collection), and admins time out after 30 idle minutes.
- `/internal/*` endpoints need the `x-agent-key` header.

**Uploads.**
- Public images (menus, kitchens, profiles) go in `uploads/` and are served statically.
- Verification documents and delivery proof photos go in `private-uploads/` and are only served through signed-in endpoints.
- Files are checked by content (`utils/fileSignature.js`), and images are re-encoded to strip EXIF (`sharp`).

## Conventions

- Soft delete uses `deleted_at`, and every read must exclude deleted records.
- Paged lists return `{ items|<name>, meta: { page, limit, total, ... } }`.
- `400 VALIDATION_ERROR` carries field-level `details`.
- Error messages are written for end users, in plain language.
- Never print secrets or DB passwords: use `maskUri` and `redactUrl`.
- When you add or change an endpoint, update `../KitchenLink-frontend/API_CONTRACT.md` and the frontend's `src/api/`. The mobile apps and the website's demo server (`src/demo/server.js` in the frontend) mirror these endpoints too.
