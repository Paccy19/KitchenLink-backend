process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { periodContaining, previousPeriod, highlights, toCsv } = require('../../src/services/kitchen/reportService');
const access = require('../../src/config/kitchenAccess');

test('periods follow Rwanda time (UTC+2): a day starts at 22:00 UTC the evening before', () => {
  const day = periodContaining('daily', new Date('2026-03-10T23:30:00Z')); // 01:30 on 11 March in Kigali
  assert.equal(day.start.toISOString(), '2026-03-10T22:00:00.000Z');
  assert.equal(day.end.toISOString(), '2026-03-11T22:00:00.000Z');
  assert.equal(day.label, '11 Mar 2026');
});

test('weeks start on Monday, months on the 1st, years on 1 January', () => {
  const week = periodContaining('weekly', new Date('2026-03-12T10:00:00Z')); // Thursday
  assert.equal(week.start.toISOString(), '2026-03-08T22:00:00.000Z'); // Monday 9 March, Kigali midnight
  assert.equal(periodContaining('monthly', new Date('2026-03-12T10:00:00Z')).label, 'March 2026');
  assert.equal(periodContaining('yearly', new Date('2026-03-12T10:00:00Z')).start.toISOString(), '2025-12-31T22:00:00.000Z');
  assert.equal(previousPeriod(periodContaining('monthly', new Date('2026-01-05T10:00:00Z'))).label, 'December 2025');
});

test('highlights say what happened in plain words', () => {
  const lines = highlights({
    period: { type: 'weekly' },
    summary: { orders_placed: 12, orders_cancelled: 2, sales_rwf: 50000, busiest_hour: '12:00–13:00', avg_prep_minutes: 14 },
    change: { sales_percent: 25 },
    departments: [{ name: 'Coffee', sales_rwf: 30000, items_sold: 20 }, { name: 'Food', sales_rwf: 20000, items_sold: 8 }],
    top_products: [{ name: 'Cappuccino', quantity: 15 }],
    payments: { outstanding_rwf: 0, unpaid_invoices: [] },
    inventory: { low_stock: [] },
  });
  assert.match(lines[0], /RWF 50,000 across 10 orders, up 25% on last week/);
  assert.ok(lines.some((l) => l.startsWith('Coffee brought in the most')));
  assert.ok(lines.some((l) => l.includes('2 orders were cancelled')));
  assert.deepEqual(highlights({ period: { type: 'daily' }, summary: { orders_placed: 0 } }), ['No orders in this period.']);
});

test('CSV cells that start like a formula are made harmless', () => {
  const csv = toCsv({
    period: { label: 'Today' },
    summary: {},
    sales: {},
    highlights: [],
    departments: [],
    top_products: [{ name: '=HYPERLINK("x")', department: 'Bar', quantity: 1, sales_rwf: 100 }],
    series: [],
    payments: null,
    staff: null,
    inventory: { most_used: [], low_stock: [] },
  });
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
});

test('administrator-only permissions can never be put in a role', () => {
  assert.ok(!access.ROLE_ASSIGNABLE.includes('account.wallet'));
  assert.ok(!access.ROLE_ASSIGNABLE.includes('account.settings'));
  for (const role of access.DEFAULT_ROLES) {
    for (const permission of role.permissions) assert.ok(access.PERMISSIONS[permission], `${role.key}: ${permission} exists`);
  }
  assert.equal(access.paymentGate('before_preparation'), 'preparation');
  assert.equal(access.paymentGate('end_of_session'), 'none');
});
