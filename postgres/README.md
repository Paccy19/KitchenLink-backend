# PostgreSQL mirror (same server, same folder)

This folder holds the PostgreSQL side of the project. MongoDB remains the
application's **source of truth** — application code does not read or write
PostgreSQL. The mirror exists so both databases run on the same server inside
one Node process (`npm run dev` / `npm start` opens both at boot).

| File | Purpose |
| --- | --- |
| `schema.sql` | Full DDL: 25 tables, CHECK constraints, indexes, 46 deferred foreign keys, purge function. |
| `../src/db/postgres.js` | Shared `pg.Pool` (from `PG_URI`) used by the server boot and both scripts. |
| `../src/scripts/migratePostgres.js` | MongoDB → PostgreSQL copy + PASS/FAIL verification. |
| `../src/scripts/seedPostgres.js` | Seeds MongoDB (admin/commission/categories/demo drivers) and mirrors those 4 tables. |

## Requirements

- PostgreSQL running on this machine (tested with PostgreSQL 18, port 5432).
- Connection settings in `backend/.env` (gitignored):

  ```
  PG_URI=postgresql://<user>:<password>@127.0.0.1:5432/online_food_kitchen
  ```

  The scripts connect as a **superuser** (e.g. `postgres`): the load uses
  `session_replication_role = replica`, which requires it.

## Commands (run in `backend/`)

```bash
npm run migrate:pg   # apply schema + copy every MongoDB collection, verify parity
npm run seed:pg      # seed admin/commission/categories/drivers, mirror them, verify
npm run dev          # API boot: MongoDB + PostgreSQL both connect (warning-only if PG is down)
```

Typical order on a fresh machine: **migrate:pg → seed:pg → npm run dev**.

## How the migration behaves

- **Full refresh snapshot**: every run drops and recreates all 25 tables, then
  copies the current MongoDB state. Re-run it after new activity in MongoDB.
- **Identical IDs**: `_id` is stored as `CHAR(24)` holding the exact ObjectId
  hex, so every reference matches MongoDB one-to-one.
- **Type mapping**: embedded objects → `JSONB`, string arrays → `TEXT[]`,
  money/ratings → `NUMERIC`, dates → `TIMESTAMPTZ` (snake_case, including
  `created_at`/`updated_at`), enums → `TEXT` + `CHECK`.
- **Dangling references**: MongoDB does not enforce foreign keys, so source
  data may contain references to missing parents. These are copied unchanged
  (the load runs with foreign keys disabled, like `pg_dump`) and reported by
  the verification as *referential parity* — PostgreSQL must show exactly the
  same dangling references as MongoDB, none fixed, none extra.
- **Verification**: every run prints a per-table report (row counts, `_id`
  sets, a sample column compared row-by-row, referential parity) and exits
  non-zero on any mismatch — `ALL CHECKS PASSED` is the success line.

## How seeding behaves

`seed:pg` is idempotent and works in two phases:

1. Seeds **MongoDB** through the application's own logic — identical to
   `npm run seed:admin` + `seed:categories` + `seed:drivers` (super admin,
   15% global commission, the 10 official food categories, 4 demo delivery
   workers with OTP login).
2. Mirrors the four affected tables (`admins`, `commissions`, `categories`,
   `drivers`) into PostgreSQL with identical `_id`s: existing rows are
   upserted, rows deleted in MongoDB are deleted in PostgreSQL.

It requires `migrate:pg` to have run first (tables must exist).

## Notes / troubleshooting

- **PostgreSQL down?** The API still starts: it logs
  `PostgreSQL mirror unavailable (...)` and keeps serving from MongoDB only.
- **`relation "…" does not exist`** during `seed:pg` → run `migrate:pg` first.
- **Passwords are masked** in every log line (`postgresql://postgres:***@…`);
  the real password lives only in `.env`.
- The API never writes to PostgreSQL, so PG data only changes when you run
  `migrate:pg` / `seed:pg`.
