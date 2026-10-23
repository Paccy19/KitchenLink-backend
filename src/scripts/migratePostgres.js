/* eslint-disable no-console */
/**
 * MongoDB -> PostgreSQL migration for the same-server mirror.
 *
 * - Applies postgres/schema.sql (all 25 tables, indexes, foreign keys).
 * - Copies every MongoDB document into PostgreSQL with byte-identical _id
 *   values (CHAR(24) ObjectId hex), so all references match MongoDB exactly.
 * - Verifies parity: row counts, _id sets, sample column values and
 *   referential integrity are compared and a PASS/FAIL report is printed.
 *
 * Usage: npm run migrate:pg    (MongoDB stays the source of truth)
 * Config: PG_URI in backend/.env
 *
 * Application code is untouched by this script; re-running it drops and
 * rebuilds the PostgreSQL snapshot from MongoDB.
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const config = require('../config');
const { pool } = require('../db/postgres');

const PG_URI = process.env.PG_URI || 'postgresql://postgres@127.0.0.1:5432/online_food_kitchen';
const SCHEMA_PATH = path.join(__dirname, '..', '..', 'postgres', 'schema.sql');
const CHUNK_SIZE = 200;

/**
 * Column specs: mongoField -> pg type.
 *   oid    -> CHAR(24) ObjectId hex (String(v))
 *   date   -> TIMESTAMPTZ
 *   json   -> JSONB (JSON.stringify, same structure as MongoDB)
 *   text[] -> TEXT[] (same values)
 *   text/num/int/bool -> passed through
 * `sample` names a column compared row-by-row during verification.
 */
const SPECS = [
  {
    table: 'admins', collection: 'admins', sample: 'email',
    fields: {
      name: 'text', email: 'text', password_hash: 'text', role: 'text',
      permissions: 'text[]', status: 'text', is_active: 'bool', phone: 'text',
      two_factor_enabled: 'bool', invite_token_hash: 'text',
      invite_expires_at: 'date', invited_at: 'date', invited_by: 'oid',
      accepted_at: 'date', deactivated_at: 'date', last_login_at: 'date',
      deleted_at: 'date',
    },
  },
  {
    table: 'adminactionlogs', collection: 'adminactionlogs', sample: 'target_type',
    fields: {
      admin_id: 'oid', admin_name: 'text', admin_email: 'text', action: 'text',
      target_type: 'text', target_id: 'text', target_label: 'text',
      metadata: 'json', ip: 'text',
    },
  },
  {
    table: 'categories', collection: 'categories', sample: 'name',
    fields: {
      name: 'text', icon_url: 'text', description: 'text',
      sort_order: 'int', is_active: 'bool',
    },
  },
  {
    table: 'customers', collection: 'customers', sample: 'phone_number',
    fields: {
      name: 'text', phone_number: 'text', profile_image_url: 'text',
      is_verified: 'bool', is_active: 'bool', last_login_at: 'date',
      last_location: 'json', last_location_accuracy_m: 'num', last_location_at: 'date',
    },
  },
  {
    table: 'vendors', collection: 'vendors', sample: 'name',
    fields: {
      name: 'text', vendor_type: 'text', vendor_type_request: 'json', ordering_settings: 'json', owner_name: 'text', description: 'text',
      email: 'text', phone: 'text', password_hash: 'text', last_login_at: 'date',
      location: 'json', neighborhood: 'text', address: 'text', rating: 'num',
      estimated_prep_time: 'num', is_active: 'bool', is_open: 'bool',
      location_updated_at: 'date', location_accuracy_m: 'num',
      is_featured: 'bool', banner_image_url: 'text', profile_image_url: 'text',
      delivery_available: 'bool', food_category_ids: 'text[]',
      food_categories: 'text[]', operating_hours: 'json', special: 'json',
      payment_information: 'json', verification_documents: 'json',
      documents_reviewed_at: 'date', documents_reviewed_by: 'oid',
      verification_status: 'text', rejection_reason: 'text',
      suspension_reason: 'text', suspended_at: 'date', available_balance: 'num',
      total_sales: 'num', deleted_at: 'date',
    },
  },
  {
    table: 'drivers', collection: 'drivers', sample: 'phone',
    fields: {
      name: 'text', phone: 'text', email: 'text', password_hash: 'text',
      last_login_at: 'date', vehicle_type: 'text', plate_number: 'text',
      license_number: 'text', location: 'json', location_updated_at: 'date',
      is_online: 'bool', is_available: 'bool', status: 'text',
      active_deliveries_count: 'int', max_active_deliveries: 'int',
      rating: 'num', rating_count: 'int', completed_deliveries: 'int',
      total_earnings_rwf: 'num', available_balance_rwf: 'num',
      profile_image_url: 'text', verification_status: 'text',
      rejection_reason: 'text', suspension_reason: 'text', suspended_at: 'date',
      is_active: 'bool', deleted_at: 'date',
    },
  },
  {
    table: 'menuitems', collection: 'menuitems', sample: 'name',
    fields: {
      vendor_id: 'oid', category_id: 'oid', name: 'text', description: 'text',
      price_rwf: 'num', preparation_time_minutes: 'num', is_available: 'bool',
      is_preorder: 'bool', preorder_cutoff: 'text', is_popular: 'bool',
      image_url: 'text', orders_count: 'int', deleted_at: 'date',
    },
  },
  {
    table: 'menuitemoptions', collection: 'menuitemoptions', sample: 'name',
    fields: {
      menu_item_id: 'oid', vendor_id: 'oid', group_name: 'text', name: 'text',
      additional_price_rwf: 'num', is_available: 'bool', sort_order: 'int',
      deleted_at: 'date',
    },
  },
  {
    table: 'orders', collection: 'orders', sample: 'order_number',
    fields: {
      order_number: 'text', customer_id: 'oid', vendor_id: 'oid',
      items: 'json', subtotal_rwf: 'num', delivery_fee_rwf: 'num',
      delivery_distance_km: 'num', delivery_distance_source: 'text',
      total_rwf: 'num', delivery_location: 'json', payment_method: 'text',
      payment_status: 'text', payment_details: 'json', order_type: 'text',
      scheduled_for: 'date', special_text: 'text', status: 'text',
      status_history: 'json', rider: 'json', driver_id: 'oid',
      delivery_id: 'oid', eta_minutes: 'num', estimated_delivery_at: 'date',
      picked_up_at: 'date', delivered_at: 'date', completed_at: 'date',
      cancelled_at: 'date', cancel_reason: 'text', commission_percent: 'num',
      commission_rwf: 'num', vendor_payout_rwf: 'num', rider_payout_rwf: 'num',
      settlement_status: 'text', settled_at: 'date',
      rider_payout_settled_at: 'date',
    },
  },
  {
    table: 'deliveries', collection: 'deliveries', sample: 'order_number',
    fields: {
      order_id: 'oid', order_number: 'text', vendor_id: 'oid',
      customer_id: 'oid', driver_id: 'oid', pickup_location: 'json',
      delivery_location: 'json', route_distance_km: 'num',
      delivery_fee_rwf: 'num', promised_earnings_rwf: 'num',
      payment_method: 'text', status: 'text', otp_code: 'text',
      otp_verified_at: 'date', proof_photo_url: 'text', dispatch: 'json',
      rejected_by: 'text[]', status_history: 'json', assigned_at: 'date',
      picked_up_at: 'date', out_for_delivery_at: 'date', delivered_at: 'date',
      completed_at: 'date', cancelled_at: 'date', cancel_reason: 'text',
    },
  },
  {
    table: 'payments', collection: 'payments', sample: 'reference',
    fields: {
      order_id: 'oid', customer_id: 'oid', amount_rwf: 'num', method: 'text',
      provider: 'text', status: 'text', reference: 'text',
      failure_reason: 'text', paid_at: 'date',
    },
  },
  {
    table: 'withdrawals', collection: 'withdrawals', sample: 'reference',
    fields: {
      payee_type: 'text', vendor_id: 'oid', driver_id: 'oid',
      amount_rwf: 'num', method: 'text', method_label: 'text',
      account_number: 'text', account_name: 'text', status: 'text',
      reference: 'text', failure_reason: 'text', processed_at: 'date',
      deleted_at: 'date',
    },
  },
  {
    table: 'otpcodes', collection: 'otpcodes', sample: 'phone_number',
    fields: {
      phone_number: 'text', purpose: 'text', context: 'text', code: 'text',
      name: 'text', attempts: 'int', expires_at: 'date', consumed_at: 'date',
    },
  },
  {
    table: 'notifications', collection: 'notifications', sample: 'title',
    fields: {
      customer_id: 'oid', driver_id: 'oid', admin_id: 'oid', vendor_id: 'oid',
      audience: 'text', type: 'text', title: 'text', body: 'text',
      order_id: 'oid', data: 'json', sms_status: 'text', sms_error: 'text',
      read_at: 'date', read_by: 'text[]',
    },
  },
  {
    table: 'complaints', collection: 'complaints', sample: 'reference',
    fields: {
      reference: 'text', subject: 'text', description: 'text', category: 'text',
      priority: 'text', status: 'text', raised_by: 'json', related: 'json',
      assigned_to: 'oid', messages: 'json', last_message_at: 'date',
      unread_by_user: 'bool', unread_by_admin: 'bool', notes: 'json',
      resolved_at: 'date', resolved_by: 'oid', deleted_at: 'date',
    },
  },
  {
    table: 'commissions', collection: 'commissions', sample: 'name',
    fields: {
      name: 'text', scope: 'text', vendor_id: 'oid', category_id: 'oid',
      vendor_type: 'text', percentage: 'num', fixed_fee_rwf: 'num',
      is_active: 'bool', deleted_at: 'date',
    },
  },
  {
    table: 'platformaccounts', collection: 'platformaccounts', sample: 'key',
    fields: {
      key: 'text', cash_balance_rwf: 'num', held_balance_rwf: 'num',
      vendor_payable_rwf: 'num', driver_payable_rwf: 'num',
      refunds_owed_rwf: 'num', commission_balance_rwf: 'num',
      unreconciled_rwf: 'num', total_adjustments_rwf: 'num',
      total_owner_withdrawn_rwf: 'num', owner_processing_rwf: 'num',
      last_sweep_week: 'text', last_sweep_at: 'date',
      last_sweep_amount_rwf: 'num', total_collected_rwf: 'num',
      total_refunded_rwf: 'num', total_commission_rwf: 'num',
      total_vendor_earnings_rwf: 'num', total_driver_earnings_rwf: 'num',
      total_vendor_payouts_rwf: 'num', total_driver_payouts_rwf: 'num',
      computed_at: 'date',
    },
  },
  {
    table: 'payoutdestinations', collection: 'payoutdestinations', sample: 'label',
    fields: {
      label: 'text', type: 'text', provider: 'text', account_name: 'text',
      account_number: 'text', status: 'text', activates_at: 'date',
      created_by: 'oid', removed_at: 'date',
    },
  },
  {
    table: 'ownerpayoutsettings', collection: 'ownerpayoutsettings', sample: 'key',
    fields: {
      key: 'text', method: 'text', destination_id: 'oid', schedule: 'json',
      updated_by: 'oid',
    },
  },
  {
    table: 'platformwithdrawals', collection: 'platformwithdrawals', sample: 'status',
    fields: {
      amount_rwf: 'num', destination_id: 'oid', destination: 'json',
      status: 'text', source: 'text', provider: 'text', reference: 'text',
      failure_reason: 'text', requested_by: 'oid', processed_by: 'oid',
      processed_at: 'date',
    },
  },
  {
    table: 'reconciliationchecks', collection: 'reconciliationchecks', sample: 'account_label',
    fields: {
      account_label: 'text', statement_date: 'date',
      statement_balance_rwf: 'num', system_cash_rwf: 'num',
      difference_rwf: 'num', note: 'text', recorded_by: 'oid',
    },
  },
  {
    table: 'refunds', collection: 'refunds', sample: 'order_number',
    fields: {
      order_id: 'oid', order_number: 'text', customer_id: 'oid',
      vendor_id: 'oid', amount_rwf: 'num', payment_method: 'text',
      destination: 'json', status: 'text', cancelled_by: 'text',
      reason: 'text', provider: 'text', reference: 'text',
      failure_reason: 'text', attempts: 'int', processed_by: 'oid',
      completed_at: 'date', failed_at: 'date',
    },
  },
  {
    table: 'transactions', collection: 'transactions', sample: 'type',
    fields: {
      type: 'text', direction: 'text', status: 'text', amount_rwf: 'num',
      order_id: 'oid', customer_id: 'oid', vendor_id: 'oid', driver_id: 'oid',
      reference: 'text', description: 'text', metadata: 'json',
    },
  },
  {
    table: 'cartitems', collection: 'cartitems',
    fields: {
      customer_id: 'oid', menu_item_id: 'oid', vendor_id: 'oid',
      quantity: 'int',
    },
  },
  {
    table: 'wishlistitems', collection: 'wishlistitems',
    fields: {
      customer_id: 'oid', menu_item_id: 'oid',
    },
  },
];

/**
 * All 46 foreign keys (must match postgres/schema.sql constraint names).
 * MongoDB does not enforce referential integrity, so source data can contain
 * dangling references; these are detected up-front and copied unchanged so
 * PostgreSQL stays byte-identical to MongoDB (reported during verification).
 */
const FKS = [
  { child: 'admins', column: 'invited_by', parent: 'admins', name: 'admins_invited_by_fk' },
  { child: 'adminactionlogs', column: 'admin_id', parent: 'admins', name: 'adminactionlogs_admin_fk' },
  { child: 'cartitems', column: 'customer_id', parent: 'customers', name: 'cartitems_customer_fk' },
  { child: 'cartitems', column: 'menu_item_id', parent: 'menuitems', name: 'cartitems_menu_item_fk' },
  { child: 'cartitems', column: 'vendor_id', parent: 'vendors', name: 'cartitems_vendor_fk' },
  { child: 'commissions', column: 'vendor_id', parent: 'vendors', name: 'commissions_vendor_fk' },
  { child: 'commissions', column: 'category_id', parent: 'categories', name: 'commissions_category_fk' },
  { child: 'complaints', column: 'assigned_to', parent: 'admins', name: 'complaints_assigned_to_fk' },
  { child: 'complaints', column: 'resolved_by', parent: 'admins', name: 'complaints_resolved_by_fk' },
  { child: 'deliveries', column: 'order_id', parent: 'orders', name: 'deliveries_order_fk' },
  { child: 'deliveries', column: 'vendor_id', parent: 'vendors', name: 'deliveries_vendor_fk' },
  { child: 'deliveries', column: 'customer_id', parent: 'customers', name: 'deliveries_customer_fk' },
  { child: 'deliveries', column: 'driver_id', parent: 'drivers', name: 'deliveries_driver_fk' },
  { child: 'menuitems', column: 'vendor_id', parent: 'vendors', name: 'menuitems_vendor_fk' },
  { child: 'menuitems', column: 'category_id', parent: 'categories', name: 'menuitems_category_fk' },
  { child: 'menuitemoptions', column: 'menu_item_id', parent: 'menuitems', name: 'menuitemoptions_item_fk' },
  { child: 'menuitemoptions', column: 'vendor_id', parent: 'vendors', name: 'menuitemoptions_vendor_fk' },
  { child: 'notifications', column: 'customer_id', parent: 'customers', name: 'notifications_customer_fk' },
  { child: 'notifications', column: 'driver_id', parent: 'drivers', name: 'notifications_driver_fk' },
  { child: 'notifications', column: 'admin_id', parent: 'admins', name: 'notifications_admin_fk' },
  { child: 'notifications', column: 'vendor_id', parent: 'vendors', name: 'notifications_vendor_fk' },
  { child: 'notifications', column: 'order_id', parent: 'orders', name: 'notifications_order_fk' },
  { child: 'orders', column: 'customer_id', parent: 'customers', name: 'orders_customer_fk' },
  { child: 'orders', column: 'vendor_id', parent: 'vendors', name: 'orders_vendor_fk' },
  { child: 'orders', column: 'driver_id', parent: 'drivers', name: 'orders_driver_fk' },
  { child: 'orders', column: 'delivery_id', parent: 'deliveries', name: 'orders_delivery_fk' },
  { child: 'ownerpayoutsettings', column: 'destination_id', parent: 'payoutdestinations', name: 'ownerpayoutsettings_destination_fk' },
  { child: 'ownerpayoutsettings', column: 'updated_by', parent: 'admins', name: 'ownerpayoutsettings_updated_by_fk' },
  { child: 'payments', column: 'order_id', parent: 'orders', name: 'payments_order_fk' },
  { child: 'payments', column: 'customer_id', parent: 'customers', name: 'payments_customer_fk' },
  { child: 'payoutdestinations', column: 'created_by', parent: 'admins', name: 'payoutdestinations_created_by_fk' },
  { child: 'platformwithdrawals', column: 'destination_id', parent: 'payoutdestinations', name: 'platformwithdrawals_destination_fk' },
  { child: 'platformwithdrawals', column: 'requested_by', parent: 'admins', name: 'platformwithdrawals_requested_by_fk' },
  { child: 'platformwithdrawals', column: 'processed_by', parent: 'admins', name: 'platformwithdrawals_processed_by_fk' },
  { child: 'reconciliationchecks', column: 'recorded_by', parent: 'admins', name: 'reconciliationchecks_recorded_by_fk' },
  { child: 'refunds', column: 'order_id', parent: 'orders', name: 'refunds_order_fk' },
  { child: 'refunds', column: 'customer_id', parent: 'customers', name: 'refunds_customer_fk' },
  { child: 'refunds', column: 'vendor_id', parent: 'vendors', name: 'refunds_vendor_fk' },
  { child: 'refunds', column: 'processed_by', parent: 'admins', name: 'refunds_processed_by_fk' },
  { child: 'transactions', column: 'order_id', parent: 'orders', name: 'transactions_order_fk' },
  { child: 'transactions', column: 'customer_id', parent: 'customers', name: 'transactions_customer_fk' },
  { child: 'transactions', column: 'vendor_id', parent: 'vendors', name: 'transactions_vendor_fk' },
  { child: 'transactions', column: 'driver_id', parent: 'drivers', name: 'transactions_driver_fk' },
  { child: 'vendors', column: 'documents_reviewed_by', parent: 'admins', name: 'vendors_documents_reviewed_by_fk' },
  { child: 'withdrawals', column: 'vendor_id', parent: 'vendors', name: 'withdrawals_vendor_fk' },
  { child: 'withdrawals', column: 'driver_id', parent: 'drivers', name: 'withdrawals_driver_fk' },
];

const transform = (type, value) => {
  if (value === undefined) return undefined;
  switch (type) {
    case 'oid':
      return value === null ? null : String(value);
    case 'date': {
      if (value === null) return null;
      const date = value instanceof Date ? value : new Date(value);
      return Number.isNaN(date.getTime()) ? undefined : date;
    }
    case 'json':
      return value === null ? 'null' : JSON.stringify(value);
    case 'text[]': {
      if (value === null) return [];
      const arr = Array.isArray(value) ? value : [value];
      return arr.map((v) => (v === null || v === undefined ? null : String(v)));
    }
    case 'text':
      return value === null ? null : String(value);
    case 'num':
      return value === null ? null : Number(value);
    case 'int':
      return value === null ? null : Math.round(Number(value));
    case 'bool':
      return value === null ? null : Boolean(value);
    default:
      return value;
  }
};

/**
 * Builds the PostgreSQL row object for a MongoDB document: _id first, every
 * spec field, plus created_at/updated_at (snake_case, matching schema.sql).
 * undefined values are skipped so the column DEFAULT applies.
 */
const toRowValues = (spec, doc) => {
  const values = { _id: String(doc._id) };
  for (const [field, type] of Object.entries(spec.fields)) {
    const v = transform(type, doc[field]);
    if (v !== undefined) values[field] = v;
  }
  for (const tsField of ['created_at', 'updated_at']) {
    const v = transform('date', doc[tsField]);
    if (v !== undefined) values[tsField] = v;
  }
  return values;
};

const buildInsert = (table, rows) => {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r.values)))];
  let idx = 0;
  const values = rows.map((row) => {
    const cells = columns.map((col) => {
      const v = row.values[col];
      if (v === undefined) return 'DEFAULT';
      idx += 1;
      return `$${idx}`;
    });
    return `(${cells.join(', ')})`;
  });
  const params = [];
  for (const row of rows) {
    for (const col of columns) {
      const v = row.values[col];
      if (v !== undefined) params.push(v);
    }
  }
  return {
    text: `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${values.join(', ')}`,
    params,
  };
};

// Must run on the migration transaction client — inserts through the pool
// would open separate connections without session_replication_role=replica
// and fail on dangling references.
const insertRows = async (client, table, rows) => {
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const { text, params } = buildInsert(table, chunk);
    // Savepoints keep the transaction usable after a failed statement so the
    // row-by-row retry below can report the exact offending document.
    await client.query('SAVEPOINT chunk');
    try {
      await client.query(text, params);
      await client.query('RELEASE SAVEPOINT chunk');
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT chunk');
      for (const row of chunk) {
        const single = buildInsert(table, [row]);
        await client.query('SAVEPOINT row_retry');
        try {
          await client.query(single.text, single.params);
          await client.query('RELEASE SAVEPOINT row_retry');
        } catch (rowErr) {
          await client.query('ROLLBACK TO SAVEPOINT row_retry');
          throw new Error(
            `${table} (_id=${row.id}): ${rowErr.message} [original bulk error: ${err.message}]`
          );
        }
      }
    }
  }
};

const run = async () => {
  const started = Date.now();
  console.log(`MongoDB source : ${config.mongoUri}`);
  console.log(
    `PostgreSQL tgt : ${(process.env.PG_URI || '').replace(/:\/\/([^:]+):[^@]*@/, '://$1:***@')}`
  );

  await mongoose.connect(config.mongoUri);
  const db = mongoose.connection.db;

  // 1. Schema ----------------------------------------------------------------
  const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  console.log('\nApplying postgres/schema.sql ...');
  await pool.query(schemaSql);
  console.log('Schema applied (25 tables, indexes, deferred foreign keys).');

  // 2. Load documents + detect dangling references --------------------------
  const failures = [];
  const summary = [];
  const mongoCollections = (await db.listCollections().toArray()).map((c) => c.name);
  const specCollections = SPECS.map((s) => s.collection);
  const unmapped = mongoCollections.filter((c) => !specCollections.includes(c));
  if (unmapped.length) {
    console.warn(`WARNING: collections without a spec (skipped): ${unmapped.join(', ')}`);
  }

  const docsBySpec = new Map();
  for (const spec of SPECS) {
    docsBySpec.set(spec, await db.collection(spec.collection).find({}).toArray());
  }

  const parentIds = new Map(); // table -> Set<_id>
  for (const spec of SPECS) {
    parentIds.set(spec.table, new Set(docsBySpec.get(spec).map((d) => String(d._id))));
  }
  const mongoOrphans = new Map(); // fk -> Set<child _id>
  for (const fk of FKS) {
    const childSpec = SPECS.find((s) => s.table === fk.child);
    const parents = parentIds.get(fk.parent);
    const orphanIds = new Set();
    for (const doc of docsBySpec.get(childSpec)) {
      const ref = doc[fk.column];
      if (ref !== null && ref !== undefined && !parents.has(String(ref))) {
        orphanIds.add(String(doc._id));
      }
    }
    if (orphanIds.size) {
      mongoOrphans.set(fk, orphanIds);
      console.warn(
        `NOTE: ${fk.child}.${fk.column} -> ${fk.parent} has ${orphanIds.size} dangling reference(s) in MongoDB; kept identical in PostgreSQL.`
      );
    }
  }

  // 3. Copy data -------------------------------------------------------------
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Same technique as pg_dump: skip foreign-key enforcement for the load so
    // source-data quirks (dangling refs above) migrate byte-identical.
    await client.query('SET LOCAL session_replication_role = replica');
    for (const spec of SPECS) {
      const docs = docsBySpec.get(spec);
      const rows = docs.map((doc) => ({ id: String(doc._id), values: toRowValues(spec, doc) }));
      if (rows.length) await insertRows(client, spec.table, rows);
      summary.push({ spec, rows });
    }
    // Flush deferred constraint checks while enforcement is off, then restore
    // normal FK enforcement for everything after this migration.
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET LOCAL session_replication_role = origin');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\nMIGRATION FAILED — PostgreSQL transaction rolled back.');
    console.error(err.message);
    throw err;
  } finally {
    client.release();
  }

  // 4. Verification ----------------------------------------------------------
  console.log('\nVerifying MongoDB <-> PostgreSQL parity ...');
  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    `${pad('TABLE', 24)}${pad('MONGO', 8)}${pad('POSTGRES', 10)}${pad('IDS', 6)}${pad('SAMPLE', 8)}RESULT`
  );

  let allPassed = true;
  let totalRows = 0;
  for (const { spec, rows } of summary) {
    const countRes = await pool.query(`SELECT count(*)::int AS c FROM ${spec.table}`);
    const pgCount = countRes.rows[0].c;
    const mongoCount = rows.length;
    totalRows += mongoCount;

    const idResult = await pool.query(`SELECT _id FROM ${spec.table}`);
    const pgIds = new Set(idResult.rows.map((r) => r._id));
    const missing = rows.filter((r) => !pgIds.has(r.id));
    const extra = [...pgIds].filter((id) => !rows.some((r) => r.id === id));
    const idsOk = missing.length === 0 && extra.length === 0;

    let sampleOk = true;
    if (spec.sample) {
      const pgRows = await pool.query(
        `SELECT _id, ${spec.sample} AS v FROM ${spec.table}`
      );
      const pgValues = new Map(pgRows.rows.map((r) => [r._id, r.v === null ? null : String(r.v)]));
      for (const row of rows) {
        const expected = row.values[spec.sample];
        const actual = pgValues.get(row.id);
        const expStr = expected === undefined || expected === null ? null : String(expected);
        if (expStr !== actual) {
          sampleOk = false;
          failures.push(
            `${spec.table} (_id=${row.id}) sample field ${spec.sample}: mongo=${JSON.stringify(expStr)} pg=${JSON.stringify(actual)}`
          );
        }
      }
    }

    const ok = pgCount === mongoCount && idsOk && sampleOk;
    if (!ok) {
      allPassed = false;
      if (pgCount !== mongoCount) failures.push(`${spec.table}: count mongo=${mongoCount} pg=${pgCount}`);
      for (const r of missing) failures.push(`${spec.table}: _id ${r.id} missing in PostgreSQL`);
      for (const id of extra) failures.push(`${spec.table}: extra _id ${id} in PostgreSQL`);
    }
    console.log(
      `${pad(spec.table, 24)}${pad(mongoCount, 8)}${pad(pgCount, 10)}${pad(idsOk ? 'ok' : 'FAIL', 6)}${pad(spec.sample ? (sampleOk ? 'ok' : 'FAIL') : '-', 8)}${ok ? 'PASS' : 'FAIL'}`
    );
  }

  console.log('-'.repeat(64));

  // Referential parity: PostgreSQL must show exactly the same dangling
  // references as MongoDB (none extra, none "fixed" — the data is a mirror).
  let fkOk = true;
  for (const fk of FKS) {
    const res = await pool.query(
      `SELECT c._id FROM ${fk.child} c
         LEFT JOIN ${fk.parent} p ON p._id = c.${fk.column}
        WHERE c.${fk.column} IS NOT NULL AND p._id IS NULL`
    );
    const pgOrphans = new Set(res.rows.map((r) => r._id));
    const expected = mongoOrphans.get(fk) || new Set();
    for (const id of expected) {
      if (!pgOrphans.has(id)) {
        fkOk = false;
        failures.push(`${fk.child}.${fk.column}: dangling ref on _id=${id} present in MongoDB but missing in PostgreSQL`);
      }
    }
    for (const id of pgOrphans) {
      if (!expected.has(id)) {
        fkOk = false;
        failures.push(`${fk.child}.${fk.column}: unexpected dangling ref on _id=${id} in PostgreSQL (not in MongoDB)`);
      }
    }
  }
  const orphanTotal = [...mongoOrphans.values()].reduce((n, s) => n + s.size, 0);
  console.log(
    `Referential parity: ${orphanTotal} dangling reference(s) in MongoDB, all preserved identically in PostgreSQL — ${fkOk ? 'ok' : 'FAIL'}`
  );
  if (!fkOk) allPassed = false;

  if (allPassed) {
    console.log(`ALL CHECKS PASSED — ${totalRows} rows migrated in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
    console.log('Next (optional): npm run seed:pg   — ensures admin/commission/categories/demo drivers exist.');
  } else {
    console.log('VERIFICATION FAILED:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }

  await mongoose.disconnect();
  await pool.end();
};

module.exports = { SPECS, transform, toRowValues };

// Run only when executed directly (npm run migrate:pg). seedPostgres.js
// requires this file to reuse the column specs and value transformer.
if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
