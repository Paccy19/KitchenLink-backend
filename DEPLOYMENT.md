# KitchenLink — Production Deployment Guide

Target: Ubuntu VPS (Contabo) running Docker Engine + Docker Compose, serving

| Address | What |
| --- | --- |
| `https://igikoni.online` | React website |
| `https://www.igikoni.online` | permanent redirect to `https://igikoni.online` (path kept) |
| `https://api.igikoni.online` | Node.js/Express API (`/api/v1/...`, photos under `/uploads/...`) |

All deployment files live in this repository under [`deploy/`](deploy/). The
website is built from the **KitchenLink-frontend** repository, cloned next to
this one.

---

## 1. Architecture

```
                 Internet (ports 80, 443 only)
                            │
                    ┌───────▼────────┐
                    │     caddy      │  HTTPS (Let's Encrypt), www redirect
                    └──┬──────────┬──┘
     igikoni.online    │          │   api.igikoni.online
              ┌────────▼───┐  ┌───▼─────────┐
              │  frontend  │  │   backend   │  Node 24, port 4000
              │ Caddy :8080│  │  (API)      │  volumes: uploads, private_uploads
              └────────────┘  └──┬───────┬──┘
   network "edge" ───────────────┼───────┼────────────────────────────
   network "data" (internal, no internet, no published ports)
                          ┌──────▼──┐ ┌──▼────────┐
                          │  mongo  │ │ postgres  │
                          │  8.0    │ │ 18        │
                          └─────────┘ └───────────┘
                          mongo_data   pg_data
```

| Service | Image / build | Role | Persistent data |
| --- | --- | --- | --- |
| `caddy` | `caddy:2-alpine` | Public reverse proxy, automatic HTTPS | `caddy_data` (certificates), `caddy_config` |
| `frontend` | `../../KitchenLink-frontend/Dockerfile` | Vite production build served by Caddy: SPA fallback, caching, security headers | — (rebuilt from Git) |
| `backend` | `../Dockerfile` | API (`node src/server.js`), runs as non-root `node` user | `uploads` (public photos), `private_uploads` (ID documents) |
| `mongo` | `mongo:8.0` | **Source of truth** for all application data | `mongo_data` |
| `postgres` | `postgres:18-alpine` | **Read-only mirror** of MongoDB (the API never reads/writes it; filled by `npm run migrate:pg`) | `pg_data` |

Things to know:

- **MongoDB is the database that matters.** Back it up. PostgreSQL can be rebuilt from it at any time.
- The API still needs `PG_URI` set with a username and password, or it refuses to start. If PostgreSQL is down, it only logs a warning.
- Every container restarts automatically (`unless-stopped`), including after a VPS reboot, as long as Docker is enabled at boot (it is by default).
- Data lives in named Docker volumes, so it survives `docker compose down`, image rebuilds and reboots. **Only `docker compose down -v` or `docker volume rm` deletes it. Never run those.**
- Logs use Docker's `json-file` driver with rotation: 10 MB × 5 files per container.

### Files

| File | Purpose |
| --- | --- |
| [`Dockerfile`](Dockerfile), [`.dockerignore`](.dockerignore) | API image (no `.env`, no uploads, no Windows `node_modules` inside) |
| [`deploy/docker-compose.prod.yml`](deploy/docker-compose.prod.yml) | The production stack |
| [`deploy/Caddyfile`](deploy/Caddyfile) | Domains, HTTPS, www redirect, HSTS |
| [`deploy/.env.example`](deploy/.env.example) | → `deploy/.env`: domains, DB passwords, website build values |
| [`deploy/backend.env.example`](deploy/backend.env.example) | → `deploy/backend.env`: API settings and secrets |
| [`deploy/mongo-init/01-create-app-user.js`](deploy/mongo-init/01-create-app-user.js) | Creates the app's MongoDB user on the very first start |
| [`deploy/scripts/backup.sh`](deploy/scripts/backup.sh), [`restore.sh`](deploy/scripts/restore.sh) | Backups and restores |
| `KitchenLink-frontend/Dockerfile`, `docker/Caddyfile` | Website image |

The existing development workflow is unchanged: `npm run dev` in both repos, using your local MongoDB and PostgreSQL, the backend `.env` and the frontend `.env`.

---

## 2. Environment variables

There are two files, and both are gitignored. Never commit them.

### `deploy/.env` (read by Docker Compose)

| Variable | Required | Notes |
| --- | --- | --- |
| `SITE_DOMAIN`, `WWW_DOMAIN`, `API_DOMAIN` | defaults | `igikoni.online`, `www.igikoni.online`, `api.igikoni.online` |
| `ACME_EMAIL` | **yes** | Let's Encrypt contact (expiry warnings) |
| `VITE_API_BASE_URL` | **yes** | `https://api.igikoni.online/api/v1`. Baked into the website at build time, and the build refuses anything that isn't https. |
| `VITE_UPLOADS_ORIGIN` | **yes** | `https://api.igikoni.online` (photos, for the Content Security Policy) |
| `VITE_API_TIMEOUT` | no | ms, default 8000 |
| `VITE_CARTO_API_KEY` | no | Map tiles. Restrict it to `igikoni.online` in the CARTO console. |
| `MONGO_ROOT_USER` / `MONGO_ROOT_PASSWORD` | **yes** | MongoDB administrator (backups, maintenance) |
| `MONGO_APP_DB` / `MONGO_APP_USER` / `MONGO_APP_PASSWORD` | **yes** | The API's own user, with `readWrite` on that one database |
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | **yes** | Mirror database. `migrate:pg` needs this user to be a superuser, which the official image makes it. |

Compose refuses to start if a required password is empty. Passwords go into
connection URLs, so use **letters and digits only** (`openssl rand -hex 32`).

### `deploy/backend.env` (read by the API)

Every variable the backend reads is listed in [`deploy/backend.env.example`](deploy/backend.env.example)
(same names as the development [`.env.example`](.env.example)). The API checks them at
startup ([`src/config/startupCheck.js`](src/config/startupCheck.js)) and **refuses to start** with the
full list of problems when any of these is wrong:

| Variable | Production value |
| --- | --- |
| `FRONTEND_URL` | `https://igikoni.online` |
| `ALLOWED_ORIGINS` | `https://igikoni.online,https://www.igikoni.online` (CORS: exact origins) |
| `PUBLIC_BASE_URL` | `https://api.igikoni.online` (photo links are built from it) |
| `JWT_SECRET` | 32+ random characters (`openssl rand -hex 48`) |
| `AGENT_API_KEY` | 32+ random characters, different from `JWT_SECRET` |
| `SMS_ENABLED`, `SMS_API_URL`, `SMS_API_KEY` | real SMS gateway, see [§14](#14-sms-and-payments) |
| `ADMIN_SEED_PASSWORD` | 12+ characters, needed only while the database has no admin yet |

These are also required for correct production behaviour:

- `TRUST_PROXY=1`: Caddy is one proxy in front of the API, so per-IP rate limits see real visitors.
- `ADMIN_SEED_EMAIL`
- `MAIL_FROM`
- `GEOCODER_USER_AGENT`

Optional features (`EMAIL_*`/`SMTP_*`, `GOOGLE_MAPS_API_KEY`, `SUPPORT_*`) are
listed as warnings in the startup log when they're off.

**Road distance for delivery prices.** When an admin turns on per-meter
pricing (Settings → Delivery fee by distance), every delivery needs a real road
distance. If no routing service answers, delivery is refused with "try again or
choose pickup" instead of charging a guess. See [DELIVERY.md](DELIVERY.md).

| Variable | Default | Production advice |
| --- | --- | --- |
| `ROUTING_PROVIDER` | `auto` | `auto` = Google Routes if `GOOGLE_MAPS_API_KEY` is set, then OSRM. Also `google`, `osrm`, `none`. |
| `OSRM_URL` | public demo server | The public server is for light use only. For real traffic, set `GOOGLE_MAPS_API_KEY` or run your own OSRM server with Rwanda/OpenStreetMap data. |
| `OSRM_MIN_INTERVAL_MS` | `1000` | Keep `1000` for the public server; `0` for your own server |
| `ROUTING_TIMEOUT_MS` | `5000` | Time allowed per routing request |
| `GOOGLE_MAPS_CACHE_TTL_SECONDS` | `600` | How long a measured route is reused, so the checkout quote matches the charge |

The compose file sets these itself, so **don't** put them in `backend.env`:
`NODE_ENV=production`, `PORT=4000`, `MONGODB_URI`, `PG_URI`, `UPLOAD_DIR=/app/uploads`, `PRIVATE_UPLOAD_DIR=/app/private-uploads`.

---

## 3. Preparing on Windows (PowerShell)

Install:

- **Git for Windows**
- **Node.js 24**
- **Docker Desktop**, with the WSL 2 backend. You need it to build or validate the images locally. Production itself does not need it.

Run the normal checks before every release:

```powershell
cd C:\Users\USER\KitchenLink-project\KitchenLink-backend
npm ci
npm test                      # needs your local MongoDB (uses a throwaway *_test database)

cd ..\KitchenLink-frontend
npm ci
$env:VITE_API_BASE_URL = "https://api.igikoni.online/api/v1"
$env:VITE_UPLOADS_ORIGIN = "https://api.igikoni.online"
npm run build                 # production build into dist\ (gitignored)
Remove-Item Env:VITE_API_BASE_URL, Env:VITE_UPLOADS_ORIGIN
```

Validate the compose file and build the images. This needs Docker Desktop. It uses throwaway example values and never touches real secrets:

```powershell
cd C:\Users\USER\KitchenLink-project\KitchenLink-backend\deploy
# Create local copies only if they don't exist yet (never overwrite):
if (-not (Test-Path .env))         { Copy-Item .env.example .env }
if (-not (Test-Path backend.env))  { Copy-Item backend.env.example backend.env }
# Put any value into the CHANGE_ME passwords in .env, then:
docker compose -f docker-compose.prod.yml config --quiet   # no output = valid
docker compose -f docker-compose.prod.yml build            # builds frontend + backend images
```

Line endings: `.gitattributes` keeps `*.sh`, `Dockerfile`, `Caddyfile` and
`deploy/**` as LF even when edited on Windows. Shell scripts break with CRLF.
The production configuration uses only Linux paths, and the Windows commands
above use Windows paths.

You can't run the full production stack on your PC under the real domains,
because Let's Encrypt only issues certificates to the server the DNS points at.

---

## 4. Building the production containers

On the server, from `deploy/`:

```bash
docker compose -f docker-compose.prod.yml build            # frontend + backend
docker compose -f docker-compose.prod.yml pull caddy mongo postgres
```

- `frontend`: runs `npm ci`, then `npm run build` with the `VITE_*` values from `deploy/.env`, and copies the resulting `dist/` into a small Caddy image.
- `backend`: runs `npm ci --omit=dev`, then copies `src/` and `postgres/`. It runs as user `node` and checks itself with `GET /api/v1/health`.

Pinning: the databases use `mongo:8.0` and `postgres:18-alpine`. A major
version never changes by itself. To freeze an exact patch release, replace
the tag with a digest (`docker images --digests`).

---

## 5. Deploying on a fresh Ubuntu VPS

Run these as a sudo user on the VPS.

```bash
# 1. Updates + firewall (SSH first so you don't lock yourself out)
sudo apt update && sudo apt -y upgrade
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw enable

# 2. Docker Engine + Compose plugin (official repository)
sudo apt -y install ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker $USER     # log out and back in afterwards

# 3. Code: both repositories side by side
sudo mkdir -p /opt/kitchenlink && sudo chown $USER: /opt/kitchenlink
cd /opt/kitchenlink
git clone https://github.com/Paccy19/KitchenLink-backend.git
git clone https://github.com/Paccy19/KitchenLink-frontend.git
# (check out the release branch/tag you want in both)

# 4. Settings (fill in every CHANGE_ME; generate secrets with: openssl rand -hex 48)
cd /opt/kitchenlink/KitchenLink-backend/deploy
cp -n .env.example .env
cp -n backend.env.example backend.env
nano .env
nano backend.env
chmod 600 .env backend.env
chmod +x scripts/*.sh

# 5. Start (only after DNS points here, see §6)
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps        # all "healthy" / "running"
docker compose -f docker-compose.prod.yml logs -f backend
```

**Docker and ufw:** ports that Docker publishes bypass ufw rules. In this
stack only Caddy publishes anything (80/443), so MongoDB (27017) and
PostgreSQL (5432) stay unreachable from outside. Never add a `ports:` entry
to `mongo` or `postgres`. To inspect them, use `docker compose exec` (§10)
or an SSH tunnel.

---

## 6. Domain DNS

At your domain registrar's DNS settings for `igikoni.online`, create:

| Type | Name | Value | TTL |
| --- | --- | --- | --- |
| A | `@` | `<VPS IPv4>` | 300 |
| A | `www` | `<VPS IPv4>` | 300 |
| A | `api` | `<VPS IPv4>` | 300 |
| AAAA (only if the VPS has IPv6 and Docker is set up for it) | `@`, `www`, `api` | `<VPS IPv6>` | 300 |

Remove any parking or default records for these names. Check propagation from Windows:

```powershell
Resolve-DnsName igikoni.online
Resolve-DnsName www.igikoni.online
Resolve-DnsName api.igikoni.online
```

All three must show the VPS IP **before** you start Caddy. Otherwise Let's
Encrypt validation fails repeatedly and can hit its rate limits.

---

## 7. Caddy and HTTPS

[`deploy/Caddyfile`](deploy/Caddyfile) handles all three domains. When Caddy starts with DNS in
place, it obtains and renews certificates automatically and stores them in the
`caddy_data` volume. Keep that volume.

- `igikoni.online` → `frontend:8080`, with HSTS and gzip/zstd.
- `www.igikoni.online` → `301` to `https://igikoni.online{uri}`.
- `api.igikoni.online` → `backend:4000`. Caddy overwrites any client-supplied `X-Forwarded-For`, which makes `TRUST_PROXY=1` safe.

The website container ([`KitchenLink-frontend/docker/Caddyfile`](../KitchenLink-frontend/docker/Caddyfile)) adds:

- **SPA fallback:** refreshing `/vendors/map` or any other route serves `index.html`. Missing `/assets/*` files still return 404.
- **Caching:** `/assets/*` (hashed names) is cached for 1 year, `immutable`. Everything else, including `index.html`, is `no-cache`, so a new release shows up immediately.
- **Headers:** `frame-ancestors 'none'` and `X-Frame-Options: DENY`, which the `<meta>` CSP can't set; `nosniff`; `Referrer-Policy`; and a `Permissions-Policy` that allows geolocation only on this site.

The main Content Security Policy is generated by `vite.config.js` from `VITE_API_BASE_URL` and `VITE_UPLOADS_ORIGIN`.

To test certificate issuance without rate-limit risk, temporarily add
`acme_ca https://acme-staging-v02.api.letsencrypt.org/directory` inside the
global `{ }` block. Remove it afterwards and run
`docker compose -f docker-compose.prod.yml exec caddy caddy reload --config /etc/caddy/Caddyfile`.

Check the result:

```bash
curl -I https://igikoni.online
curl -I https://www.igikoni.online           # 301 → https://igikoni.online/
curl https://api.igikoni.online/api/v1/health
```

---

## 8. Initializing PostgreSQL and MongoDB safely

**On the first start** (empty volumes), everything is automatic:

1. `mongo` creates the root user and runs `mongo-init/01-create-app-user.js`, which creates the API user. This only runs while the volume is empty; later starts never re-run it or touch data.
2. `postgres` creates the database and user.
3. When the API starts, it:
   - builds the MongoDB indexes (Mongoose `autoIndex`)
   - creates the first super admin from `ADMIN_SEED_EMAIL`/`ADMIN_SEED_PASSWORD` if there are no admins yet
   - creates the default 15% commission
   - adds the vendor-type categories
   - runs its idempotent data fixes (vendor-type names, card-number masking, moving documents to private storage)

   All of these only add or upgrade data. None of them delete anything.
4. Sign in to the admin panel and **change the admin password**. You're asked to do this at first sign-in.

Optional, on a brand-new database only:

```bash
docker compose -f docker-compose.prod.yml exec backend npm run seed:categories
```

This sets the official food category list. It **deletes or hides categories
that aren't on that list**, so never run it once admins have edited categories.

**Never run these in production:**

| Script | Why not |
| --- | --- |
| `seed:drivers` | creates demo delivery workers who can sign in |
| `seed:pg` | includes the demo drivers |
| `src/scripts/cleanupDemoData.js` | deletes data. It refuses when `NODE_ENV=production`, but don't rely on that. |

### Moving existing data from your PC (optional)

You need the MongoDB Database Tools on Windows. On your PC:

```powershell
mongodump --uri "mongodb://127.0.0.1:27017/online_food_kitchen" --archive=mongo-local.archive.gz --gzip
tar -czf uploads-local.tar.gz -C C:\Users\USER\KitchenLink-project\KitchenLink-backend uploads private-uploads
scp mongo-local.archive.gz uploads-local.tar.gz <user>@<VPS IP>:/opt/kitchenlink/KitchenLink-backend/deploy/backups/
```

On the VPS, rename the files to match the backup naming, then restore in the default, safe "add missing" mode:

```bash
cd /opt/kitchenlink/KitchenLink-backend/deploy/backups
mv mongo-local.archive.gz mongo-import.archive.gz
mv uploads-local.tar.gz uploads-import.tar.gz
cd .. && ./scripts/restore.sh import
```

Photo links stored in the database contain the old `PUBLIC_BASE_URL`
(`http://localhost:4000/uploads/...`). Check a few vendor and menu photos
afterwards. If they point at localhost, they need a one-off URL rewrite.
Ask before running one.

---

## 9. Migrations

| What | How | Safe to repeat? |
| --- | --- | --- |
| MongoDB indexes | automatic at API start | yes |
| MongoDB data fixes (vendor types, type categories, card masking, private documents, ledger upgrade) | automatic at API start | yes, idempotent |
| `npm run migrate:vendors` | one-off backfill for vendors created before vendor login existed (fills only missing fields) | yes, never overwrites credentials |
| `npm run strip:metadata` | one-off: strips EXIF/GPS metadata from old uploaded images | yes |
| **PostgreSQL mirror** `npm run migrate:pg` | **drops and recreates the 25 mirror tables**, copies MongoDB into them, prints a PASS/FAIL parity report | yes. It only rebuilds the mirror and never changes MongoDB. |

Run them inside the API container:

```bash
cd /opt/kitchenlink/KitchenLink-backend/deploy
docker compose -f docker-compose.prod.yml exec backend npm run migrate:pg
# success line: ALL CHECKS PASSED
```

`postgres/schema.sql` was checked on 2026-11-16. It applies cleanly and
repeatably (25 tables, 102 indexes, 46 foreign keys) inside a rolled-back
transaction.

---

## 10. Logs

```bash
cd /opt/kitchenlink/KitchenLink-backend/deploy
docker compose -f docker-compose.prod.yml ps                       # status + health
docker compose -f docker-compose.prod.yml logs -f backend          # follow the API
docker compose -f docker-compose.prod.yml logs --since 1h caddy    # proxy / certificates
docker compose -f docker-compose.prod.yml logs --tail 200 mongo postgres
```

The API logs one line per request (`METHOD path status ms [request-id]`).
Error responses carry the same `X-Request-Id`, so you can find the matching
log line. Passwords are masked in connection logs.

To open a database shell (the root password comes from the container's environment):

```bash
docker compose -f docker-compose.prod.yml exec mongo sh -c 'mongosh -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin "$MONGO_APP_DB"'
docker compose -f docker-compose.prod.yml exec postgres sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB"'
```

---

## 11. Restarting services

```bash
docker compose -f docker-compose.prod.yml restart backend        # restart the API
docker compose -f docker-compose.prod.yml up -d backend          # apply backend.env changes (recreates the container; data stays)
docker compose -f docker-compose.prod.yml exec caddy caddy reload --config /etc/caddy/Caddyfile   # after editing the Caddyfile
docker compose -f docker-compose.prod.yml down                   # stop everything (volumes are kept)
docker compose -f docker-compose.prod.yml up -d                  # start everything
```

Don't use `down -v`: the `-v` flag deletes the database, upload and certificate volumes.

---

## 12. Backups and restores

```bash
cd /opt/kitchenlink/KitchenLink-backend
./deploy/scripts/backup.sh
```

The script:

- writes these files to `deploy/backups/` (gitignored, mode 700):
  - `mongo-<stamp>.archive.gz`: MongoDB, the important one
  - `postgres-<stamp>.dump`: the mirror; it can also be rebuilt
  - `uploads-<stamp>.tar.gz`: public photos and private documents
- fails if any of these files comes out empty
- deletes only its own backups older than `KEEP_DAYS` (default 14)

Use `BACKUP_DIR=/path` to write somewhere else.

Schedule it daily with `crontab -e`:

```
30 2 * * * cd /opt/kitchenlink/KitchenLink-backend && ./deploy/scripts/backup.sh >> /var/log/kitchenlink-backup.log 2>&1
```

**Copy backups off the VPS.** A backup on the same disk doesn't protect you if
the server is lost. Use `scp`/`rsync` to another machine, or object storage.
Test a restore on a separate server from time to time.

Restore:

```bash
./deploy/scripts/restore.sh 20261116T023000Z            # safe: adds missing data, keeps existing
./deploy/scripts/restore.sh 20261116T023000Z --replace  # exact rollback, asks for confirmation; newer data is lost
docker compose -f deploy/docker-compose.prod.yml exec backend npm run migrate:pg   # then rebuild the mirror
```

Take a fresh backup before any `--replace` restore.

---

## 13. Updating without losing data

```bash
cd /opt/kitchenlink/KitchenLink-backend
./deploy/scripts/backup.sh                                  # 1. backup first
git pull
(cd ../KitchenLink-frontend && git pull)                    # 2. new code
cd deploy
docker compose -f docker-compose.prod.yml build             # 3. build new images (site keeps running)
docker compose -f docker-compose.prod.yml up -d             # 4. swap containers; volumes untouched
docker compose -f docker-compose.prod.yml ps                # 5. wait for "healthy"
docker compose -f docker-compose.prod.yml logs --tail 100 backend
docker image prune -f                                       # optional: remove old images
```

- Compare `deploy/.env.example` and `backend.env.example` with your real files after each pull, in case new settings were added. Your `.env` files are never overwritten by `git pull`.
- To change the API address, edit `VITE_API_BASE_URL` and rebuild the frontend image. It's fixed at build time.
- Rollback: `git checkout <previous tag>` in both repos, then `build` and `up -d`. If the release changed data, also restore the backup from step 1.
- Upgrading MongoDB or PostgreSQL to a new **major** version (e.g. `postgres:19`) is not a normal update. Take a backup, then follow that database's upgrade procedure. Never just change the tag.

---

## 14. SMS and payments

### SMS (required to go live)

Customers, kitchens and delivery workers sign in with SMS codes. The API won't
start in production without a gateway, and it never prints codes or puts them
in responses on a production server.

The API sends one HTTP request per message (see [`src/utils/sms.js`](src/utils/sms.js)):

```
POST <SMS_API_URL>
Content-Type: application/json
<SMS_API_KEY_HEADER>: <SMS_API_KEY>          # only when SMS_API_KEY_HEADER is set

{ "to": "+2507XXXXXXXX", "from": "<SMS_SENDER_ID>", "message": "<text>" }
# if SMS_API_KEY_HEADER is empty, "api_key": "<SMS_API_KEY>" is added to the body instead
```

Any 2xx response counts as delivered. Any other response, or a timeout after
10 s, tells the user to try again.

Settings in `deploy/backend.env`:

| Variable | Value |
| --- | --- |
| `SMS_ENABLED` | `true` |
| `SMS_API_URL` | the provider's send endpoint |
| `SMS_API_KEY` | API key or token from your provider |
| `SMS_API_KEY_HEADER` | header name the provider expects (`Authorization`, `X-API-Key`, ...). If the provider expects `Authorization: Bearer <token>`, set `SMS_API_KEY` to `Bearer <token>`. |
| `SMS_SENDER_ID` | approved sender name, usually registered with the provider |
| `SMS_PROVIDER` | label only, e.g. `http` |

If your provider uses different JSON field names (for example `text` instead
of `message`), you'll need a small adapter in `src/utils/sms.js`. That's a
code change to agree on separately.

### Payments (Paypack mobile money)

Customers pay with MTN MoMo or Airtel Money through [Paypack](https://paypack.rw)
([`src/services/paypackService.js`](src/services/paypackService.js)). Card, eKash and
wallet are switched off for now (`config.payments.enabledMethods`).

Checkout sends a prompt to the customer's phone and leaves the order `pending`.
It becomes paid only when Paypack's signed webhook arrives, or when the app's
check (`POST /orders/:id/payment/check`) asks Paypack and gets "successful".
Then the kitchen is told and delivery workers are offered the order.

To turn it on:

1. Open a Paypack merchant account and create application keys in its dashboard.
2. In `deploy/backend.env`, set `PAYPACK_CLIENT_ID`, `PAYPACK_CLIENT_SECRET`,
   `PAYPACK_WEBHOOK_SECRET` (from the dashboard) and `PAYPACK_WEBHOOK_MODE=production`.
   The API refuses to start with the keys but no webhook secret.
3. Register the webhook `https://api.igikoni.online/api/v1/payments/paypack/webhook`
   in the dashboard for production mode.
4. Restart the backend, then pay a few small orders (e.g. 100 RWF) end to end.

Without the keys, checkout answers `503 PAYMENTS_NOT_CONFIGURED` with "Online
payment isn't available yet". Browsing, kitchens' dashboards, the admin panel
and driver sign-in still work.

Withdrawals and refunds stay manual (`PAYOUT_PROVIDER=manual`): an admin sends
each transfer and records its reference.

**Never set `NODE_ENV=development` on the server to get around this.** It would mark orders paid without collecting money, show sign-in codes to anyone, and accept the public example secrets.

---

## 15. Security checklist before launch

- [ ] Every `CHANGE_ME` replaced. `deploy/.env` and `backend.env` are `chmod 600` and not in Git.
- [ ] `JWT_SECRET` and `AGENT_API_KEY` are unique 32+ character random values.
- [ ] The admin password was changed at first sign-in.
- [ ] **CARTO key:** it was committed in the frontend `.env` (commit `0b3caf5`, on GitHub). Restrict it to `igikoni.online` or rotate it in the CARTO console.
- [ ] Only ports 22, 80 and 443 are open (`sudo ss -tlnp`). MongoDB and PostgreSQL aren't published.
- [ ] Daily backups run and are copied off the server. A restore has been tested.
- [ ] `GOOGLE_MAPS_API_KEY` is set, or you've accepted the limits of the free OpenStreetMap servers.
- [ ] SSH uses keys, and password login is disabled.
