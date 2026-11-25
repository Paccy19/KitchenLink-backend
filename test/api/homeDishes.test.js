const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/testServer');
const { nextOpening } = require('../../src/utils/vendorHours');

let models;

before(async () => {
  await h.start();
  models = require('../../src/models');
});

after(() => h.stop());

const WEEK = (open, close) =>
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((day) => ({
    day,
    open_time: open,
    close_time: close,
    is_closed: false,
  }));

test('GET /home/dishes pages through every available dish, with filters and sorts', async () => {
  const [grills, drinks] = await models.Category.insertMany([
    { name: 'Grills', is_active: true },
    { name: 'Drinks', is_active: true },
  ]);

  await h.createKitchen({
    name: 'Open Grill',
    rating: 4.8,
    estimated_prep_time: 25,
    dishes: [
      { name: 'Brochettes', price_rwf: 5000, category_id: grills._id, orders_count: 50 },
      { name: 'Tilapia', price_rwf: 9000, category_id: grills._id, orders_count: 10, preparation_time_minutes: 40 },
      { name: 'Sold out ribs', price_rwf: 7000, category_id: grills._id, is_available: false },
      { name: 'Deleted wings', price_rwf: 3000, category_id: grills._id, deleted_at: new Date() },
    ],
  });
  await h.createKitchen({
    name: 'Closed Juice Bar',
    rating: 4.4,
    is_open: false,
    operating_hours: WEEK('07:00', '15:00'),
    dishes: [{ name: 'Mango juice', price_rwf: 1500, category_id: drinks._id, orders_count: 99 }],
  });
  await h.createKitchen({
    name: 'Inactive kitchen',
    is_active: false,
    dishes: [{ name: 'Hidden dish', price_rwf: 100, category_id: drinks._id }],
  });
  await h.createKitchen({
    name: 'Deleted kitchen',
    deleted_at: new Date(),
    dishes: [{ name: 'Removed kitchen dish', price_rwf: 100, category_id: drinks._id }],
  });

  // Default: open kitchens first, then most ordered; closed kitchens still listed.
  let res = await h.api('GET', '/home/dishes');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.dishes.map((d) => d.name), ['Brochettes', 'Tilapia', 'Mango juice']);
  assert.equal(res.body.meta.total, 3);
  assert.equal(res.body.meta.has_more, false);
  assert.equal(res.body.meta.limit, 8, 'the default page size is eight');

  const brochettes = res.body.dishes[0];
  assert.equal(brochettes.category_name, 'Grills');
  assert.equal(brochettes.rating, 4.8);
  assert.equal(brochettes.estimated_prep_time, 25, 'falls back to the kitchen prep time');
  assert.equal(brochettes.vendor.is_open, true);
  assert.equal(brochettes.vendor.opens_at, null);

  const juice = res.body.dishes[2];
  assert.equal(juice.vendor.is_open, false);
  assert.equal(juice.vendor.opens_at.time, '07:00');

  assert.equal(brochettes.has_options, false);
  await models.MenuItemOption.create({
    menu_item_id: brochettes.id,
    vendor_id: brochettes.vendor_id,
    name: 'Spice level',
  });
  await models.MenuItemOption.create({
    menu_item_id: brochettes.id,
    vendor_id: brochettes.vendor_id,
    group_name: 'Size',
    name: 'Large',
    is_available: false,
  });
  res = await h.api('GET', '/home/dishes');
  assert.equal(res.body.dishes[0].has_options, true, 'a dish with options says so');
  const storefront = await h.api('GET', `/vendors/${brochettes.vendor_id}`);
  const storefrontDish = storefront.body.menu.flatMap((group) => group.items).find((dish) => dish.id === brochettes.id);
  assert.deepEqual(
    storefrontDish.options.map(({ group_name, name }) => ({ group_name, name })),
    [{ group_name: 'Options', name: 'Spice level' }],
    'the customer menu includes selectable options and excludes unavailable options'
  );

  // Pagination.
  res = await h.api('GET', '/home/dishes?limit=2&page=1');
  assert.deepEqual(res.body.dishes.map((d) => d.name), ['Brochettes', 'Tilapia']);
  assert.equal(res.body.meta.has_more, true);
  res = await h.api('GET', '/home/dishes?limit=2&page=2');
  assert.deepEqual(res.body.dishes.map((d) => d.name), ['Mango juice']);
  assert.equal(res.body.meta.has_more, false);

  // Category filter.
  res = await h.api('GET', `/home/dishes?category=${drinks._id}`);
  assert.deepEqual(res.body.dishes.map((d) => d.name), ['Mango juice']);

  // Sorts.
  const names = async (sort) => (await h.api('GET', `/home/dishes?sort=${sort}`)).body.dishes.map((d) => d.name);
  assert.deepEqual(await names('price_asc'), ['Mango juice', 'Brochettes', 'Tilapia']);
  assert.deepEqual(await names('price_desc'), ['Tilapia', 'Brochettes', 'Mango juice']);
  assert.deepEqual(await names('rating'), ['Brochettes', 'Tilapia', 'Mango juice']);
  assert.deepEqual((await names('delivery_time'))[2], 'Tilapia');

  // A bad category id is a 400, not a crash.
  res = await h.api('GET', '/home/dishes?category=nope');
  assert.equal(res.status, 400);

  await h.createKitchen({
    name: 'Pagination Test Kitchen',
    dishes: Array.from({ length: 17 }, (_, index) => ({
      name: `Pagination dish ${String(index + 1).padStart(2, '0')}`,
      price_rwf: 2000 + index,
      category_id: grills._id,
      orders_count: index,
    })),
  });
  const firstPage = await h.api('GET', '/home/dishes');
  const secondPage = await h.api('GET', `/home/dishes?page=2`);
  const thirdPage = await h.api('GET', `/home/dishes?page=3`);
  assert.equal(firstPage.body.dishes.length, 8);
  assert.equal(firstPage.body.meta.total, 20);
  assert.equal(firstPage.body.meta.has_more, true);
  assert.equal(secondPage.body.dishes.length, 8);
  assert.equal(secondPage.body.meta.has_more, true);
  assert.equal(thirdPage.body.dishes.length, 4);
  assert.equal(thirdPage.body.meta.has_more, false);
});

test('nextOpening finds the next opening time in Rwanda time', () => {
  const hours = WEEK('08:00', '22:00');
  // 05:00 UTC = 07:00 in Kigali: opens later today.
  assert.deepEqual(nextOpening(hours, { now: new Date('2026-11-25T05:00:00Z') }), {
    day: 'wednesday', time: '08:00', day_offset: 0,
  });
  // 21:00 UTC = 23:00 in Kigali: opens tomorrow.
  assert.deepEqual(nextOpening(hours, { now: new Date('2026-11-25T21:00:00Z') }), {
    day: 'thursday', time: '08:00', day_offset: 1,
  });
  // Closed on Thursdays: skips to Friday.
  const noThursday = hours.map((e) => (e.day === 'thursday' ? { ...e, is_closed: true } : e));
  assert.equal(nextOpening(noThursday, { now: new Date('2026-11-25T21:00:00Z') }).day, 'friday');
  assert.equal(nextOpening([], {}), null);
});
