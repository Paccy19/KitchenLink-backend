-- ============================================================================
-- Online Food Kitchen — MongoDB -> PostgreSQL schema (same-server mirror)
-- ============================================================================
-- Mirrors all 25 Mongoose models in backend/src/models/*.js (Mongoose 9.11.1).
-- Applied by `npm run migrate:pg` (src/scripts/migratePostgres.js).
--
-- Design rules (PostgreSQL stays identical to MongoDB):
--   * _id is CHAR(24) holding the exact MongoDB ObjectId hex string, so every
--     primary key / reference value is byte-identical in both databases.
--   * created_at / updated_at are snake_case timestamptz (the API contract and
--     the shared models/timestamps.js option).
--   * Enums (Mongoose enum values)      -> TEXT + CHECK (same value lists).
--   * Embedded sub-documents / arrays   -> JSONB (same structure as MongoDB).
--   * Plain string arrays ([String] /
--     [ObjectId])                       -> TEXT[] (same values).
--   * Mixed (schema.Types.Mixed)        -> JSONB DEFAULT '{}'.
--   * Money / ratings / distances       -> NUMERIC, counters -> INTEGER.
--   * Text indexes                      -> generated tsvector columns + GIN.
--   * GeoJSON `location` (2dsphere)     -> JSONB + generated latitude/longitude
--     (equals the Mongoose latitude/longitude virtuals on Driver and Vendor).
--   * All foreign keys are DEFERRABLE INITIALLY DEFERRED so rows can be
--     inserted in any order (handles the orders <-> deliveries cycle).
-- No extensions are required (no PostGIS / pg_cron). See NOTES at the bottom.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Drop existing tables (full refresh — every migrate:pg run rebuilds the
-- snapshot from MongoDB).
-- ----------------------------------------------------------------------------
DROP TABLE IF EXISTS
  withdrawals, wishlistitems, vendors, transactions, refunds,
  reconciliationchecks, platformwithdrawals, platformaccounts,
  ownerpayoutsettings, otpcodes, orders, notifications, menuitemoptions,
  menuitems, drivers, deliveries, customers, complaints, commissions,
  cartitems, categories, adminactionlogs, admins, payments,
  payoutdestinations
CASCADE;

-- ============================================================================
-- 1. admins  (model: Admin)
-- ============================================================================
CREATE TABLE admins (
  _id               CHAR(24) PRIMARY KEY,
  name              TEXT        NOT NULL DEFAULT '',
  email             TEXT        NOT NULL,
  password_hash     TEXT,
  role              TEXT        NOT NULL DEFAULT 'super_admin'
                    CHECK (role IN ('super_admin','support_agent','operations_manager',
                                    'finance_officer','analyst','support','operations','finance')),
  permissions       TEXT[]      NOT NULL DEFAULT '{}',
  status            TEXT        NOT NULL DEFAULT 'active'
                    CHECK (status IN ('invited','active')),
  is_active         BOOLEAN     NOT NULL DEFAULT TRUE,
  phone             TEXT        NOT NULL DEFAULT '',
  two_factor_enabled BOOLEAN    NOT NULL DEFAULT FALSE,
  invite_token_hash TEXT,
  invite_expires_at TIMESTAMPTZ,
  invited_at        TIMESTAMPTZ,
  invited_by        CHAR(24),
  accepted_at       TIMESTAMPTZ,
  deactivated_at    TIMESTAMPTZ,
  last_login_at     TIMESTAMPTZ,
  deleted_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (email)
);

-- ============================================================================
-- 2. adminactionlogs  (model: AdminActionLog)
-- ============================================================================
CREATE TABLE adminactionlogs (
  _id          CHAR(24) PRIMARY KEY,
  admin_id     CHAR(24),
  admin_name   TEXT        NOT NULL DEFAULT '',
  admin_email  TEXT        NOT NULL DEFAULT '',
  action       TEXT        NOT NULL,
  target_type  TEXT        NOT NULL DEFAULT 'system'
               CHECK (target_type IN ('vendor','customer','driver','order','payment',
                                      'commission','payout','withdrawal','delivery',
                                      'category','complaint','admin','system',
                                      'platform_withdrawal','payout_destination',
                                      'transaction','reconciliation','refund','admin_member')),
  target_id    TEXT        NOT NULL DEFAULT '',
  target_label TEXT        NOT NULL DEFAULT '',
  metadata     JSONB       NOT NULL DEFAULT '{}',
  ip           TEXT        NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX adminactionlogs_created_at_idx     ON adminactionlogs (created_at DESC);
CREATE INDEX adminactionlogs_admin_created_idx  ON adminactionlogs (admin_id, created_at DESC);
CREATE INDEX adminactionlogs_target_idx         ON adminactionlogs (target_type, target_id);

-- ============================================================================
-- 3. categories  (model: Category)
-- ============================================================================
CREATE TABLE categories (
  _id         CHAR(24) PRIMARY KEY,
  name        TEXT        NOT NULL UNIQUE,
  icon_url    TEXT        NOT NULL DEFAULT '',
  description TEXT        NOT NULL DEFAULT '',
  sort_order  INTEGER     NOT NULL DEFAULT 0,
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  search_vector tsvector GENERATED ALWAYS AS
                (to_tsvector('simple', coalesce(name, ''))) STORED,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX categories_sort_name_idx ON categories (sort_order, name);
CREATE INDEX categories_search_idx    ON categories USING GIN (search_vector);

-- ============================================================================
-- 4. customers  (model: Customer)
-- ============================================================================
CREATE TABLE customers (
  _id                CHAR(24) PRIMARY KEY,
  name               TEXT        NOT NULL,
  phone_number       TEXT        NOT NULL UNIQUE,
  profile_image_url  TEXT        NOT NULL DEFAULT '',
  is_verified        BOOLEAN     NOT NULL DEFAULT TRUE,
  is_active          BOOLEAN     NOT NULL DEFAULT TRUE,
  last_login_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- 5. vendors  (model: Vendor)
-- ============================================================================
CREATE TABLE vendors (
  _id                 CHAR(24) PRIMARY KEY,
  name                TEXT        NOT NULL,
  vendor_type         TEXT        NOT NULL DEFAULT 'Restaurant'
                      CHECK (vendor_type IN ('Home Cook','Restaurant','Café','Bakery',
                                             'Caterer','Food Truck','Chef','Meal-prep business',
                                             'Juice/Drinks vendor','Other food business',
                                             'Cafe','Bar & Grill')),
  owner_name          TEXT,
  description         TEXT        NOT NULL DEFAULT '',
  email               TEXT        UNIQUE,           -- sparse unique in MongoDB; PG allows many NULLs
  phone               TEXT        UNIQUE,           -- sparse unique in MongoDB; PG allows many NULLs
  password_hash       TEXT,
  last_login_at       TIMESTAMPTZ,
  location            JSONB,                        -- GeoJSON Point {type, coordinates:[lng,lat]}
  neighborhood        TEXT,
  address             TEXT,
  rating              NUMERIC     NOT NULL DEFAULT 0 CHECK (rating >= 0 AND rating <= 5),
  estimated_prep_time NUMERIC     NOT NULL DEFAULT 30 CHECK (estimated_prep_time >= 0),
  is_active           BOOLEAN     NOT NULL DEFAULT TRUE,
  is_open             BOOLEAN     NOT NULL DEFAULT TRUE,
  location_updated_at TIMESTAMPTZ,
  location_accuracy_m NUMERIC     CHECK (location_accuracy_m >= 0),
  is_featured         BOOLEAN     NOT NULL DEFAULT FALSE,
  banner_image_url    TEXT        NOT NULL DEFAULT '',
  profile_image_url   TEXT        NOT NULL DEFAULT '',
  delivery_available  BOOLEAN     NOT NULL DEFAULT FALSE,
  food_category_ids   TEXT[]      NOT NULL DEFAULT '{}',   -- [ObjectId] refs to categories
  food_categories     TEXT[]      NOT NULL DEFAULT '{}',   -- [String]
  operating_hours     JSONB       NOT NULL DEFAULT '[]',
  special             JSONB       NOT NULL DEFAULT
                      '{"text": "", "cutoff_at": null, "delivery_at": null,
                        "is_active": false, "updated_at": null}',
  payment_information JSONB       NOT NULL DEFAULT
                      '{"payout_method": "", "account_name": "", "account_number": "",
                        "bank_name": "", "mobile_money_number": ""}',
  verification_documents JSONB    NOT NULL DEFAULT '[]',
  documents_reviewed_at TIMESTAMPTZ,
  documents_reviewed_by CHAR(24),                   -- ObjectId ref to admins
  verification_status TEXT        NOT NULL DEFAULT 'approved'
                      CHECK (verification_status IN ('pending','approved','rejected','suspended')),
  rejection_reason    TEXT        NOT NULL DEFAULT '',
  suspension_reason   TEXT        NOT NULL DEFAULT '',
  suspended_at        TIMESTAMPTZ,
  available_balance   NUMERIC     NOT NULL DEFAULT 0 CHECK (available_balance >= 0),
  total_sales         NUMERIC     NOT NULL DEFAULT 0 CHECK (total_sales >= 0),
  deleted_at          TIMESTAMPTZ,
  -- Same values as the Mongoose `latitude` / `longitude` virtuals:
  latitude            DOUBLE PRECISION GENERATED ALWAYS AS
                      ((location -> 'coordinates' ->> 1)::double precision) STORED,
  longitude           DOUBLE PRECISION GENERATED ALWAYS AS
                      ((location -> 'coordinates' ->> 0)::double precision) STORED,
  search_vector       tsvector GENERATED ALWAYS AS
                      (to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(neighborhood, ''))) STORED,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX vendors_active_rating_idx    ON vendors (is_active, rating DESC);
CREATE INDEX vendors_active_featured_idx  ON vendors (is_active, is_featured DESC, rating DESC);
CREATE INDEX vendors_special_idx          ON vendors ((special ->> 'is_active'), (special ->> 'delivery_at'));
CREATE INDEX vendors_search_idx           ON vendors USING GIN (search_vector);

-- ============================================================================
-- 6. drivers  (model: Driver)
-- ============================================================================
CREATE TABLE drivers (
  _id                     CHAR(24) PRIMARY KEY,
  name                    TEXT        NOT NULL,
  phone                   TEXT        UNIQUE,       -- sparse unique in MongoDB
  email                   TEXT        UNIQUE,       -- sparse unique in MongoDB
  password_hash           TEXT,
  last_login_at           TIMESTAMPTZ,
  vehicle_type            TEXT        NOT NULL DEFAULT 'motorcycle'
                          CHECK (vehicle_type IN ('motorcycle','scooter','bicycle','car',
                                                  'foot','bike','truck')),
  plate_number            TEXT        NOT NULL DEFAULT '',
  license_number          TEXT        NOT NULL DEFAULT '',
  location                JSONB       NOT NULL DEFAULT
                          '{"type": "Point", "coordinates": [30.0619, -1.9441]}',
  location_updated_at     TIMESTAMPTZ,
  is_online               BOOLEAN     NOT NULL DEFAULT FALSE,
  is_available            BOOLEAN     NOT NULL DEFAULT TRUE,
  status                  TEXT        NOT NULL DEFAULT 'offline'
                          CHECK (status IN ('online','offline','busy')),
  active_deliveries_count INTEGER     NOT NULL DEFAULT 0 CHECK (active_deliveries_count >= 0),
  max_active_deliveries   INTEGER     NOT NULL DEFAULT 3 CHECK (max_active_deliveries >= 1),
  rating                  NUMERIC     NOT NULL DEFAULT 5 CHECK (rating >= 0 AND rating <= 5),
  rating_count            INTEGER     NOT NULL DEFAULT 0 CHECK (rating_count >= 0),
  completed_deliveries    INTEGER     NOT NULL DEFAULT 0 CHECK (completed_deliveries >= 0),
  total_earnings_rwf      NUMERIC     NOT NULL DEFAULT 0 CHECK (total_earnings_rwf >= 0),
  available_balance_rwf   NUMERIC     NOT NULL DEFAULT 0 CHECK (available_balance_rwf >= 0),
  profile_image_url       TEXT        NOT NULL DEFAULT '',
  verification_status     TEXT        NOT NULL DEFAULT 'approved'
                          CHECK (verification_status IN ('pending','approved','rejected','suspended')),
  rejection_reason        TEXT        NOT NULL DEFAULT '',
  suspension_reason       TEXT        NOT NULL DEFAULT '',
  suspended_at            TIMESTAMPTZ,
  is_active               BOOLEAN     NOT NULL DEFAULT TRUE,
  deleted_at              TIMESTAMPTZ,
  latitude                DOUBLE PRECISION GENERATED ALWAYS AS
                          ((location -> 'coordinates' ->> 1)::double precision) STORED,
  longitude               DOUBLE PRECISION GENERATED ALWAYS AS
                          ((location -> 'coordinates' ->> 0)::double precision) STORED,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Replaces the Mongo 2dsphere index for proximity-style queries (see NOTES):
CREATE INDEX drivers_location_gin_idx ON drivers USING GIN (location jsonb_path_ops);
CREATE INDEX drivers_availability_idx ON drivers (is_online, is_available, status);
CREATE INDEX drivers_active_rating_idx ON drivers (is_active, rating DESC);

-- ============================================================================
-- 7. menuitems  (model: MenuItem)
-- ============================================================================
CREATE TABLE menuitems (
  _id                      CHAR(24) PRIMARY KEY,
  vendor_id                CHAR(24)     NOT NULL,
  category_id              CHAR(24),
  name                     TEXT        NOT NULL,
  description              TEXT        NOT NULL DEFAULT '',
  price_rwf                NUMERIC     NOT NULL CHECK (price_rwf >= 0),
  preparation_time_minutes NUMERIC     NOT NULL DEFAULT 0 CHECK (preparation_time_minutes >= 0),
  is_available             BOOLEAN     NOT NULL DEFAULT TRUE,
  is_preorder              BOOLEAN     NOT NULL DEFAULT FALSE,
  preorder_cutoff          TEXT        NOT NULL DEFAULT '',
  is_popular               BOOLEAN     NOT NULL DEFAULT FALSE,
  image_url                TEXT        NOT NULL DEFAULT '',
  orders_count             INTEGER     NOT NULL DEFAULT 0 CHECK (orders_count >= 0),
  deleted_at               TIMESTAMPTZ,
  search_vector            tsvector GENERATED ALWAYS AS
                           (to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(description, ''))) STORED,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX menuitems_vendor_category_idx     ON menuitems (vendor_id, category_id);
CREATE INDEX menuitems_vendor_deleted_idx      ON menuitems (vendor_id, deleted_at, created_at DESC);
CREATE INDEX menuitems_category_available_idx  ON menuitems (category_id, is_available);
CREATE INDEX menuitems_popular_idx             ON menuitems (is_available, orders_count DESC);
CREATE INDEX menuitems_search_idx              ON menuitems USING GIN (search_vector);

-- ============================================================================
-- 8. menuitemoptions  (model: MenuItemOption)
-- ============================================================================
CREATE TABLE menuitemoptions (
  _id                    CHAR(24) PRIMARY KEY,
  menu_item_id           CHAR(24)     NOT NULL,
  vendor_id              CHAR(24)     NOT NULL,
  group_name             TEXT        NOT NULL DEFAULT 'Options',
  name                   TEXT        NOT NULL,
  additional_price_rwf   NUMERIC     NOT NULL DEFAULT 0 CHECK (additional_price_rwf >= 0),
  is_available           BOOLEAN     NOT NULL DEFAULT TRUE,
  sort_order             INTEGER     NOT NULL DEFAULT 0,
  deleted_at             TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX menuitemoptions_item_idx     ON menuitemoptions (menu_item_id, deleted_at, sort_order);
CREATE INDEX menuitemoptions_vendor_idx   ON menuitemoptions (vendor_id);

-- ============================================================================
-- 9. orders  (model: Order)
-- ============================================================================
CREATE TABLE orders (
  _id                       CHAR(24) PRIMARY KEY,
  order_number              TEXT        NOT NULL UNIQUE,
  customer_id               CHAR(24)     NOT NULL,
  vendor_id                 CHAR(24)     NOT NULL,
  items                     JSONB       NOT NULL DEFAULT '[]',
  subtotal_rwf              NUMERIC     NOT NULL,
  delivery_fee_rwf          NUMERIC     NOT NULL,
  delivery_distance_km      NUMERIC     CHECK (delivery_distance_km >= 0),
  delivery_distance_source  TEXT        CHECK (delivery_distance_source IS NULL
                                              OR delivery_distance_source IN ('google','estimate')),
  total_rwf                 NUMERIC     NOT NULL,
  delivery_location         JSONB       NOT NULL DEFAULT '{}',
  payment_method            TEXT        NOT NULL
                            CHECK (payment_method IN ('mobile_money','card','ekash','wallet')),
  payment_status            TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (payment_status IN ('pending','paid','failed','refunded')),
  payment_details           JSONB       NOT NULL DEFAULT '{}',
  order_type                TEXT        NOT NULL DEFAULT 'immediate'
                            CHECK (order_type IN ('immediate','scheduled','preorder')),
  scheduled_for             TIMESTAMPTZ,
  special_text              TEXT        NOT NULL DEFAULT '',
  status                    TEXT        NOT NULL DEFAULT 'placed'
                            CHECK (status IN ('placed','confirmed','preparing','ready','assigned',
                                              'picked_up','out_for_delivery','delivered','cancelled')),
  status_history            JSONB       NOT NULL DEFAULT '[]',
  rider                     JSONB,
  driver_id                 CHAR(24),
  delivery_id               CHAR(24),
  eta_minutes               NUMERIC,
  estimated_delivery_at     TIMESTAMPTZ,
  picked_up_at              TIMESTAMPTZ,
  delivered_at              TIMESTAMPTZ,
  completed_at              TIMESTAMPTZ,
  cancelled_at              TIMESTAMPTZ,
  cancel_reason             TEXT        NOT NULL DEFAULT '',
  commission_percent        NUMERIC     NOT NULL DEFAULT 0
                            CHECK (commission_percent >= 0 AND commission_percent <= 100),
  commission_rwf            NUMERIC     NOT NULL DEFAULT 0 CHECK (commission_rwf >= 0),
  vendor_payout_rwf         NUMERIC     NOT NULL DEFAULT 0 CHECK (vendor_payout_rwf >= 0),
  rider_payout_rwf          NUMERIC     NOT NULL DEFAULT 0 CHECK (rider_payout_rwf >= 0),
  settlement_status         TEXT        NOT NULL DEFAULT 'unpaid'
                            CHECK (settlement_status IN ('unpaid','held','settled','refunded')),
  settled_at                TIMESTAMPTZ,
  rider_payout_settled_at   TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_customer_created_idx ON orders (customer_id, created_at DESC);
CREATE INDEX orders_vendor_status_idx    ON orders (vendor_id, status);
CREATE INDEX orders_vendor_completed_idx ON orders (vendor_id, completed_at DESC);
CREATE INDEX orders_status_created_idx   ON orders (status, created_at DESC);
CREATE INDEX orders_driver_status_idx    ON orders (driver_id, status);
CREATE INDEX orders_type_scheduled_idx   ON orders (order_type, scheduled_for);

-- ============================================================================
-- 10. deliveries  (model: Delivery)
-- ============================================================================
CREATE TABLE deliveries (
  _id                   CHAR(24) PRIMARY KEY,
  order_id              CHAR(24)     NOT NULL UNIQUE,
  order_number          TEXT        NOT NULL,
  vendor_id             CHAR(24)     NOT NULL,
  customer_id           CHAR(24)     NOT NULL,
  driver_id             CHAR(24),
  pickup_location       JSONB       NOT NULL DEFAULT '{}',
  delivery_location     JSONB       NOT NULL DEFAULT '{}',
  route_distance_km     NUMERIC     NOT NULL DEFAULT 0 CHECK (route_distance_km >= 0),
  delivery_fee_rwf      NUMERIC     NOT NULL DEFAULT 0 CHECK (delivery_fee_rwf >= 0),
  promised_earnings_rwf NUMERIC     NOT NULL DEFAULT 0 CHECK (promised_earnings_rwf >= 0),
  payment_method        TEXT        NOT NULL DEFAULT '',
  status                TEXT        NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','accepted','preparing','ready_for_pickup',
                                          'assigned_to_driver','picked_up','out_for_delivery',
                                          'delivered','completed','cancelled','rejected')),
  otp_code              TEXT        NOT NULL DEFAULT '',
  otp_verified_at       TIMESTAMPTZ,
  proof_photo_url       TEXT        NOT NULL DEFAULT '',
  dispatch              JSONB       NOT NULL DEFAULT '{"broadcast_count": 0, "offers": []}',
  rejected_by           TEXT[]      NOT NULL DEFAULT '{}',   -- [ObjectId] of drivers
  status_history        JSONB       NOT NULL DEFAULT '[]',
  assigned_at           TIMESTAMPTZ,
  picked_up_at          TIMESTAMPTZ,
  out_for_delivery_at   TIMESTAMPTZ,
  delivered_at          TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  cancel_reason         TEXT        NOT NULL DEFAULT '',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX deliveries_status_created_idx    ON deliveries (status, created_at DESC);
CREATE INDEX deliveries_driver_status_idx     ON deliveries (driver_id, status);
CREATE INDEX deliveries_vendor_status_idx     ON deliveries (vendor_id, status);
CREATE INDEX deliveries_customer_created_idx  ON deliveries (customer_id, created_at DESC);
CREATE INDEX deliveries_pickup_hood_idx       ON deliveries ((pickup_location ->> 'neighborhood'));

-- ============================================================================
-- 11. payments  (model: Payment)
-- ============================================================================
CREATE TABLE payments (
  _id            CHAR(24) PRIMARY KEY,
  order_id       CHAR(24)     NOT NULL,
  customer_id    CHAR(24)     NOT NULL,
  amount_rwf     NUMERIC     NOT NULL,
  method         TEXT        NOT NULL
                 CHECK (method IN ('mobile_money','card','ekash','wallet')),
  provider       TEXT        NOT NULL,
  status         TEXT        NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','processing','successful','failed','refunded')),
  reference      TEXT        NOT NULL UNIQUE,
  failure_reason TEXT        NOT NULL DEFAULT '',
  paid_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payments_order_created_idx ON payments (order_id, created_at DESC);

-- ============================================================================
-- 12. withdrawals  (model: Withdrawal)
--    The model's pre('validate') hook becomes a CHECK constraint.
-- ============================================================================
CREATE TABLE withdrawals (
  _id             CHAR(24) PRIMARY KEY,
  payee_type      TEXT        NOT NULL DEFAULT 'vendor'
                  CHECK (payee_type IN ('vendor','driver')),
  vendor_id       CHAR(24),
  driver_id       CHAR(24),
  amount_rwf      NUMERIC     NOT NULL CHECK (amount_rwf >= 1),
  method          TEXT        NOT NULL DEFAULT 'mobile_money'
                  CHECK (method IN ('mobile_money','bank_transfer','cash','other')),
  method_label    TEXT        NOT NULL DEFAULT '',
  account_number  TEXT        NOT NULL DEFAULT '',
  account_name    TEXT        NOT NULL DEFAULT '',
  status          TEXT        NOT NULL DEFAULT 'processing'
                  CHECK (status IN ('processing','completed','failed')),
  reference       TEXT        NOT NULL DEFAULT '',
  failure_reason  TEXT        NOT NULL DEFAULT '',
  processed_at    TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- From Withdrawal.pre('validate'): the owner must exist for the payee type.
  CHECK ((payee_type = 'driver' AND driver_id IS NOT NULL)
      OR (payee_type = 'vendor' AND vendor_id IS NOT NULL))
);
CREATE INDEX withdrawals_payee_idx         ON withdrawals (payee_type);
CREATE INDEX withdrawals_vendor_created_idx ON withdrawals (vendor_id, created_at DESC);
CREATE INDEX withdrawals_driver_created_idx ON withdrawals (driver_id, created_at DESC);

-- ============================================================================
-- 13. otpcodes  (model: OtpCode)
--    MongoDB TTL index (expireAfterSeconds: 0 on expires_at) -> purge function.
-- ============================================================================
CREATE TABLE otpcodes (
  _id          CHAR(24) PRIMARY KEY,
  phone_number TEXT        NOT NULL,
  purpose      TEXT        NOT NULL DEFAULT 'customer'
               CHECK (purpose IN ('customer','vendor','driver','admin')),
  context      TEXT        NOT NULL DEFAULT '',
  code         TEXT        NOT NULL,
  name         TEXT,
  attempts     INTEGER     NOT NULL DEFAULT 0,
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX otpcodes_expires_at_idx       ON otpcodes (expires_at);
CREATE INDEX otpcodes_phone_created_idx    ON otpcodes (phone_number, created_at DESC);
CREATE INDEX otpcodes_phone_purpose_idx    ON otpcodes (phone_number, purpose, created_at DESC);

-- TTL equivalent: schedule with pg_cron (see NOTES) or run from the app:
--   SELECT purge_expired_otpcodes();
CREATE OR REPLACE FUNCTION purge_expired_otpcodes() RETURNS INTEGER AS $$
DECLARE
  deleted INTEGER;
BEGIN
  DELETE FROM otpcodes WHERE expires_at <= now();
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 14. notifications  (model: Notification)
-- ============================================================================
CREATE TABLE notifications (
  _id          CHAR(24) PRIMARY KEY,
  customer_id  CHAR(24),
  driver_id    CHAR(24),
  admin_id     CHAR(24),
  vendor_id    CHAR(24),
  audience     TEXT        NOT NULL DEFAULT 'customer'
               CHECK (audience IN ('customer','driver','admin','vendor')),
  type         TEXT        NOT NULL DEFAULT 'general'
               CHECK (type IN ('delivery_code','delivery_offer','order_update','general',
                               'vendor_application','driver_application','complaint_opened',
                               'payout_requested','payout_update','order_placed',
                               'payment_failed','owner_finance','account_update',
                               'refund_update','support_message')),
  title        TEXT        NOT NULL,
  body         TEXT        NOT NULL,
  order_id     CHAR(24),
  data         JSONB       NOT NULL DEFAULT '{}',
  sms_status   TEXT        NOT NULL DEFAULT 'pending'
               CHECK (sms_status IN ('pending','sent','failed','skipped')),
  sms_error    TEXT        NOT NULL DEFAULT '',
  read_at      TIMESTAMPTZ,
  read_by      TEXT[]      NOT NULL DEFAULT '{}',   -- [ObjectId] of admins
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_customer_created_idx ON notifications (customer_id, created_at DESC);
CREATE INDEX notifications_customer_read_idx    ON notifications (customer_id, read_at);
CREATE INDEX notifications_driver_created_idx   ON notifications (driver_id, created_at DESC);
CREATE INDEX notifications_driver_read_idx      ON notifications (driver_id, read_at);
CREATE INDEX notifications_vendor_created_idx   ON notifications (vendor_id, created_at DESC);
CREATE INDEX notifications_vendor_read_idx      ON notifications (vendor_id, read_at);
CREATE INDEX notifications_admin_idx            ON notifications (admin_id);
CREATE INDEX notifications_audience_created_idx ON notifications (audience, created_at DESC);
CREATE INDEX notifications_audience_read_idx    ON notifications (audience, read_at);

-- ============================================================================
-- 15. complaints  (model: Complaint)
-- ============================================================================
CREATE TABLE complaints (
  _id              CHAR(24) PRIMARY KEY,
  reference        TEXT        NOT NULL UNIQUE,
  subject          TEXT        NOT NULL,
  description      TEXT        NOT NULL DEFAULT '',
  category         TEXT        NOT NULL DEFAULT 'other'
                   CHECK (category IN ('order','delivery','payment','refund','app',
                                       'vendor','driver','account','other')),
  priority         TEXT        NOT NULL DEFAULT 'medium'
                   CHECK (priority IN ('low','medium','high','urgent')),
  status           TEXT        NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','in_review','resolved','rejected')),
  raised_by        JSONB       NOT NULL DEFAULT '{}',
  related          JSONB       NOT NULL DEFAULT '{}',
  assigned_to      CHAR(24),
  messages         JSONB       NOT NULL DEFAULT '[]',
  last_message_at  TIMESTAMPTZ,
  unread_by_user   BOOLEAN     NOT NULL DEFAULT FALSE,
  unread_by_admin  BOOLEAN     NOT NULL DEFAULT FALSE,
  notes            JSONB       NOT NULL DEFAULT '[]',
  resolved_at      TIMESTAMPTZ,
  resolved_by      CHAR(24),
  deleted_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX complaints_status_created_idx  ON complaints (status, created_at DESC);
CREATE INDEX complaints_category_created_idx ON complaints (category, created_at DESC);
CREATE INDEX complaints_raised_by_idx       ON complaints
               ((raised_by ->> 'role'), (raised_by ->> 'user_id'), last_message_at DESC);

-- ============================================================================
-- 16. commissions  (model: Commission)
-- ============================================================================
CREATE TABLE commissions (
  _id            CHAR(24) PRIMARY KEY,
  name           TEXT        NOT NULL,
  scope          TEXT        NOT NULL DEFAULT 'global'
                 CHECK (scope IN ('global','vendor','category','vendor_type')),
  vendor_id      CHAR(24),
  category_id    CHAR(24),
  vendor_type    TEXT        NOT NULL DEFAULT '',
  percentage     NUMERIC     NOT NULL DEFAULT 0
                 CHECK (percentage >= 0 AND percentage <= 100),
  fixed_fee_rwf  NUMERIC     NOT NULL DEFAULT 0 CHECK (fixed_fee_rwf >= 0),
  is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
  deleted_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX commissions_scope_active_idx ON commissions (scope, is_active);

-- ============================================================================
-- 17. platformaccounts  (model: PlatformAccount — single row, key='primary')
-- ============================================================================
CREATE TABLE platformaccounts (
  _id                      CHAR(24) PRIMARY KEY,
  key                      TEXT        NOT NULL DEFAULT 'primary' UNIQUE,
  cash_balance_rwf         NUMERIC     NOT NULL DEFAULT 0,
  held_balance_rwf         NUMERIC     NOT NULL DEFAULT 0,
  vendor_payable_rwf       NUMERIC     NOT NULL DEFAULT 0,
  driver_payable_rwf       NUMERIC     NOT NULL DEFAULT 0,
  refunds_owed_rwf         NUMERIC     NOT NULL DEFAULT 0,
  commission_balance_rwf   NUMERIC     NOT NULL DEFAULT 0,
  unreconciled_rwf         NUMERIC     NOT NULL DEFAULT 0,
  total_adjustments_rwf    NUMERIC     NOT NULL DEFAULT 0,
  total_owner_withdrawn_rwf NUMERIC    NOT NULL DEFAULT 0,
  owner_processing_rwf     NUMERIC     NOT NULL DEFAULT 0,
  last_sweep_week          TEXT        NOT NULL DEFAULT '',
  last_sweep_at            TIMESTAMPTZ,
  last_sweep_amount_rwf    NUMERIC     NOT NULL DEFAULT 0,
  total_collected_rwf      NUMERIC     NOT NULL DEFAULT 0,
  total_refunded_rwf       NUMERIC     NOT NULL DEFAULT 0,
  total_commission_rwf     NUMERIC     NOT NULL DEFAULT 0,
  total_vendor_earnings_rwf NUMERIC    NOT NULL DEFAULT 0,
  total_driver_earnings_rwf NUMERIC    NOT NULL DEFAULT 0,
  total_vendor_payouts_rwf NUMERIC     NOT NULL DEFAULT 0,
  total_driver_payouts_rwf NUMERIC     NOT NULL DEFAULT 0,
  computed_at              TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- 18. payoutdestinations  (model: PayoutDestination)
-- ============================================================================
CREATE TABLE payoutdestinations (
  _id             CHAR(24) PRIMARY KEY,
  label           TEXT        NOT NULL,
  type            TEXT        NOT NULL CHECK (type IN ('bank','mobile_money')),
  provider        TEXT        NOT NULL,
  account_name    TEXT        NOT NULL,
  account_number  TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','removed')),
  activates_at    TIMESTAMPTZ NOT NULL,
  created_by      CHAR(24),
  removed_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payoutdestinations_status_idx ON payoutdestinations (status);

-- ============================================================================
-- 19. ownerpayoutsettings  (model: OwnerPayoutSettings — single row, key='primary')
-- ============================================================================
CREATE TABLE ownerpayoutsettings (
  _id            CHAR(24) PRIMARY KEY,
  key            TEXT        NOT NULL DEFAULT 'primary' UNIQUE,
  method         TEXT        CHECK (method IS NULL OR method IN ('bank','mobile_money')),
  destination_id CHAR(24),
  schedule       JSONB       NOT NULL DEFAULT
                 '{"mode": "reminder", "frequency": "weekly", "weekday": 5,
                   "day_of_month": 1, "hour": 9,
                   "amount_mode": "all_available", "fixed_amount_rwf": 0}',
  updated_by     CHAR(24),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- 20. platformwithdrawals  (model: PlatformWithdrawal)
--    Mongo partial unique index `one_processing` -> partial unique index.
-- ============================================================================
CREATE TABLE platformwithdrawals (
  _id             CHAR(24) PRIMARY KEY,
  amount_rwf      NUMERIC     NOT NULL CHECK (amount_rwf >= 1),
  destination_id  CHAR(24)     NOT NULL,
  destination     JSONB       NOT NULL DEFAULT '{}',
  status          TEXT        NOT NULL DEFAULT 'processing'
                  CHECK (status IN ('processing','completed','failed')),
  source          TEXT        NOT NULL DEFAULT 'manual'
                  CHECK (source IN ('manual','weekly_sweep','auto')),
  provider        TEXT        NOT NULL DEFAULT 'manual',
  reference       TEXT        NOT NULL DEFAULT '',
  failure_reason  TEXT        NOT NULL DEFAULT '',
  requested_by    CHAR(24),
  processed_by    CHAR(24),
  processed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX platformwithdrawals_created_idx ON platformwithdrawals (created_at DESC);
CREATE UNIQUE INDEX platformwithdrawals_one_processing_idx
  ON platformwithdrawals (status) WHERE status = 'processing';

-- ============================================================================
-- 21. reconciliationchecks  (model: ReconciliationCheck)
-- ============================================================================
CREATE TABLE reconciliationchecks (
  _id                   CHAR(24) PRIMARY KEY,
  account_label         TEXT        NOT NULL,
  statement_date        TIMESTAMPTZ NOT NULL,
  statement_balance_rwf NUMERIC     NOT NULL,
  system_cash_rwf       NUMERIC     NOT NULL,
  difference_rwf        NUMERIC     NOT NULL,
  note                  TEXT        NOT NULL DEFAULT '',
  recorded_by           CHAR(24),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reconciliationchecks_statement_date_idx ON reconciliationchecks (statement_date DESC);

-- ============================================================================
-- 22. refunds  (model: Refund)
-- ============================================================================
CREATE TABLE refunds (
  _id             CHAR(24) PRIMARY KEY,
  order_id        CHAR(24)     NOT NULL UNIQUE,   -- one refund per order
  order_number    TEXT        NOT NULL DEFAULT '',
  customer_id     CHAR(24)     NOT NULL,
  vendor_id       CHAR(24),
  amount_rwf      NUMERIC     NOT NULL CHECK (amount_rwf >= 0),
  payment_method  TEXT        NOT NULL DEFAULT '',
  destination     JSONB       NOT NULL DEFAULT
                  '{"type": "mobile_money", "phone": "", "card_last4": ""}',
  status          TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','completed','failed')),
  cancelled_by    TEXT        NOT NULL DEFAULT 'system'
                  CHECK (cancelled_by IN ('customer','vendor','admin','system')),
  reason          TEXT        NOT NULL DEFAULT '',
  provider        TEXT        NOT NULL DEFAULT 'manual',
  reference       TEXT        NOT NULL DEFAULT '',
  failure_reason  TEXT        NOT NULL DEFAULT '',
  attempts        INTEGER     NOT NULL DEFAULT 0,
  processed_by    CHAR(24),
  completed_at    TIMESTAMPTZ,
  failed_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refunds_status_created_idx    ON refunds (status, created_at DESC);
CREATE INDEX refunds_customer_created_idx  ON refunds (customer_id, created_at DESC);

-- ============================================================================
-- 23. transactions  (model: Transaction — money ledger, append-only)
-- ============================================================================
CREATE TABLE transactions (
  _id          CHAR(24) PRIMARY KEY,
  type         TEXT        NOT NULL
               CHECK (type IN ('order_payment','vendor_earning','driver_earning',
                               'commission','refund','adjustment','platform_withdrawal',
                               'vendor_payout','driver_payout','withdrawal')),
  direction    TEXT        NOT NULL CHECK (direction IN ('credit','debit','internal')),
  status       TEXT        NOT NULL DEFAULT 'settled'
               CHECK (status IN ('held','settled','refunded')),
  amount_rwf   NUMERIC     NOT NULL,   -- signed for type='adjustment'
  order_id     CHAR(24),
  customer_id  CHAR(24),
  vendor_id    CHAR(24),
  driver_id    CHAR(24),
  reference    TEXT        NOT NULL DEFAULT '',
  description  TEXT        NOT NULL DEFAULT '',
  metadata     JSONB       NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX transactions_created_idx    ON transactions (created_at DESC);
CREATE INDEX transactions_type_created_idx ON transactions (type, created_at DESC);

-- ============================================================================
-- 24. cartitems  (model: CartItem)
-- ============================================================================
CREATE TABLE cartitems (
  _id           CHAR(24) PRIMARY KEY,
  customer_id   CHAR(24)     NOT NULL,
  menu_item_id  CHAR(24)     NOT NULL,
  vendor_id     CHAR(24)     NOT NULL,
  quantity      INTEGER     NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, menu_item_id)
);
CREATE INDEX cartitems_customer_vendor_idx ON cartitems (customer_id, vendor_id);

-- ============================================================================
-- 25. wishlistitems  (model: WishlistItem)
-- ============================================================================
CREATE TABLE wishlistitems (
  _id           CHAR(24) PRIMARY KEY,
  customer_id   CHAR(24)     NOT NULL,
  menu_item_id  CHAR(24)     NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, menu_item_id)
);
CREATE INDEX wishlistitems_customer_created_idx ON wishlistitems (customer_id, created_at DESC);

-- ============================================================================
-- FOREIGN KEYS (all deferred -> any insert order works)
-- ============================================================================
ALTER TABLE admins             ADD CONSTRAINT admins_invited_by_fk
  FOREIGN KEY (invited_by) REFERENCES admins (_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE adminactionlogs    ADD CONSTRAINT adminactionlogs_admin_fk
  FOREIGN KEY (admin_id) REFERENCES admins (_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE cartitems          ADD CONSTRAINT cartitems_customer_fk
  FOREIGN KEY (customer_id) REFERENCES customers (_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE cartitems          ADD CONSTRAINT cartitems_menu_item_fk
  FOREIGN KEY (menu_item_id) REFERENCES menuitems (_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE cartitems          ADD CONSTRAINT cartitems_vendor_fk
  FOREIGN KEY (vendor_id) REFERENCES vendors (_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE commissions         ADD CONSTRAINT commissions_vendor_fk
  FOREIGN KEY (vendor_id) REFERENCES vendors (_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE commissions         ADD CONSTRAINT commissions_category_fk
  FOREIGN KEY (category_id) REFERENCES categories (_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE complaints          ADD CONSTRAINT complaints_assigned_to_fk
  FOREIGN KEY (assigned_to) REFERENCES admins (_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE complaints          ADD CONSTRAINT complaints_resolved_by_fk
  FOREIGN KEY (resolved_by) REFERENCES admins (_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE deliveries          ADD CONSTRAINT deliveries_order_fk
  FOREIGN KEY (order_id) REFERENCES orders (_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE deliveries          ADD CONSTRAINT deliveries_vendor_fk
  FOREIGN KEY (vendor_id) REFERENCES vendors (_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE deliveries          ADD CONSTRAINT deliveries_customer_fk
  FOREIGN KEY (customer_id) REFERENCES customers (_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE deliveries          ADD CONSTRAINT deliveries_driver_fk
  FOREIGN KEY (driver_id) REFERENCES drivers (_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE menuitems           ADD CONSTRAINT menuitems_vendor_fk
  FOREIGN KEY (vendor_id) REFERENCES vendors (_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE menuitems           ADD CONSTRAINT menuitems_category_fk
  FOREIGN KEY (category_id) REFERENCES categories (_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE menuitemoptions     ADD CONSTRAINT menuitemoptions_item_fk
  FOREIGN KEY (menu_item_id) REFERENCES menuitems (_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE menuitemoptions     ADD CONSTRAINT menuitemoptions_vendor_fk
  FOREIGN KEY (vendor_id) REFERENCES vendors (_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE notifications       ADD CONSTRAINT notifications_customer_fk
  FOREIGN KEY (customer_id) REFERENCES customers (_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE notifications       ADD CONSTRAINT notifications_driver_fk
  FOREIGN KEY (driver_id) REFERENCES drivers (_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE notifications       ADD CONSTRAINT notifications_admin_fk
  FOREIGN KEY (admin_id) REFERENCES admins (_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE notifications       ADD CONSTRAINT notifications_vendor_fk
  FOREIGN KEY (vendor_id) REFERENCES vendors (_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE notifications       ADD CONSTRAINT notifications_order_fk
  FOREIGN KEY (order_id) REFERENCES orders (_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE orders              ADD CONSTRAINT orders_customer_fk
  FOREIGN KEY (customer_id) REFERENCES customers (_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE orders              ADD CONSTRAINT orders_vendor_fk
  FOREIGN KEY (vendor_id) REFERENCES vendors (_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE orders              ADD CONSTRAINT orders_driver_fk
  FOREIGN KEY (driver_id) REFERENCES drivers (_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE orders              ADD CONSTRAINT orders_delivery_fk
  FOREIGN KEY (delivery_id) REFERENCES deliveries (_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ownerpayoutsettings ADD CONSTRAINT ownerpayoutsettings_destination_fk
  FOREIGN KEY (destination_id) REFERENCES payoutdestinations (_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ownerpayoutsettings ADD CONSTRAINT ownerpayoutsettings_updated_by_fk
  FOREIGN KEY (updated_by) REFERENCES admins (_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE payments            ADD CONSTRAINT payments_order_fk
  FOREIGN KEY (order_id) REFERENCES orders (_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE payments            ADD CONSTRAINT payments_customer_fk
  FOREIGN KEY (customer_id) REFERENCES customers (_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE payoutdestinations  ADD CONSTRAINT payoutdestinations_created_by_fk
  FOREIGN KEY (created_by) REFERENCES admins (_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE platformwithdrawals ADD CONSTRAINT platformwithdrawals_destination_fk
  FOREIGN KEY (destination_id) REFERENCES payoutdestinations (_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE platformwithdrawals ADD CONSTRAINT platformwithdrawals_requested_by_fk
  FOREIGN KEY (requested_by) REFERENCES admins (_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE platformwithdrawals ADD CONSTRAINT platformwithdrawals_processed_by_fk
  FOREIGN KEY (processed_by) REFERENCES admins (_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE reconciliationchecks ADD CONSTRAINT reconciliationchecks_recorded_by_fk
  FOREIGN KEY (recorded_by) REFERENCES admins (_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE refunds             ADD CONSTRAINT refunds_order_fk
  FOREIGN KEY (order_id) REFERENCES orders (_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE refunds             ADD CONSTRAINT refunds_customer_fk
  FOREIGN KEY (customer_id) REFERENCES customers (_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE refunds             ADD CONSTRAINT refunds_vendor_fk
  FOREIGN KEY (vendor_id) REFERENCES vendors (_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE refunds             ADD CONSTRAINT refunds_processed_by_fk
  FOREIGN KEY (processed_by) REFERENCES admins (_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE transactions        ADD CONSTRAINT transactions_order_fk
  FOREIGN KEY (order_id) REFERENCES orders (_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE transactions        ADD CONSTRAINT transactions_customer_fk
  FOREIGN KEY (customer_id) REFERENCES customers (_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE transactions        ADD CONSTRAINT transactions_vendor_fk
  FOREIGN KEY (vendor_id) REFERENCES vendors (_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE transactions        ADD CONSTRAINT transactions_driver_fk
  FOREIGN KEY (driver_id) REFERENCES drivers (_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE vendors             ADD CONSTRAINT vendors_documents_reviewed_by_fk
  FOREIGN KEY (documents_reviewed_by) REFERENCES admins (_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE withdrawals         ADD CONSTRAINT withdrawals_vendor_fk
  FOREIGN KEY (vendor_id) REFERENCES vendors (_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE withdrawals         ADD CONSTRAINT withdrawals_driver_fk
  FOREIGN KEY (driver_id) REFERENCES drivers (_id) DEFERRABLE INITIALLY DEFERRED;

COMMIT;

-- ============================================================================
-- NOTES
-- ============================================================================
-- 1. TTL (otpcodes.expires_at): MongoDB deletes expired docs automatically.
--    In PostgreSQL run `SELECT purge_expired_otpcodes();` on a schedule, e.g.
--    with pg_cron:  SELECT cron.schedule('otp-purge', '*/5 * * * *',
--                                         $$SELECT purge_expired_otpcodes()$$);
-- 2. Geo search (mongo 2dsphere on drivers/vendors location): for true radius
--    queries install the PostGIS extension and build geometry(Point,4326)
--    columns; the jsonb GIN index above covers simple lookups without it.
-- 3. Text search: `search_vector` generated columns replicate MongoDB text
--    indexes on categories.name, menuitems.name+description,
--    vendors.name+neighborhood. Query with:  search_vector @@ to_tsquery(...)
-- ============================================================================
