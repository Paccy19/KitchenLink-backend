// Automatic food categories by vendor type: kitchens never pick categories at
// registration — they get their type's defaults (existing categories reused,
// equivalents like Drinks for Beverages, missing ones created at start-up).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/testServer');

let models;
let ensureTypeCategories;
let vendorCategoryService;
let adminVendorService;
let DEFAULT_FOOD_CATEGORIES;

// The categories KitchenLink databases already have (npm run seed:categories).
const EXISTING = [
  'Local Food', 'Fast Food', 'African Food', 'Healthy Food', 'Bakery', 'Breakfast',
  'Lunch', 'Dinner', 'Drinks', 'Desserts', 'Breads', 'Pastries', 'Cakes', 'Cookies',
];

before(async () => {
  await h.start();
  models = require('../../src/models');
  ensureTypeCategories = require('../../src/scripts/ensureTypeCategories');
  vendorCategoryService = require('../../src/services/vendorCategoryService');
  adminVendorService = require('../../src/services/adminVendorService');
  ({ DEFAULT_FOOD_CATEGORIES } = require('../../src/config/vendorTypes'));
  // As in a real database: seeded categories, Bakery ones tagged, the rest saved before tags existed.
  await models.Category.collection.insertMany(
    EXISTING.map((name, index) => ({
      name,
      sort_order: index + 1,
      is_active: true,
      ...(['Breads', 'Pastries', 'Cakes', 'Cookies'].includes(name) ? { vendor_types: ['bakery'] } : {}),
    }))
  );
});
after(() => h.stop());

let phone = 0;
const registerBody = (vendorType, extra = {}) => {
  phone += 1;
  return {
    name: `Auto ${vendorType} kitchen`,
    vendor_type: vendorType,
    owner_name: 'Aline Uwase',
    // Airtel 073…: never the 078… numbers testServer.createCustomer makes.
    phone: `073${String(process.pid % 10000).padStart(4, '0')}${String(phone).padStart(3, '0')}`,
    description: 'Fresh food made every day for our neighbours.',
    location: { address: 'KN 5 Rd', neighborhood: 'Kiyovu', latitude: -1.95, longitude: 30.06 },
    operating_hours: [{ day: 'monday', open_time: '08:00', close_time: '20:00' }],
    payment_information: { payout_method: 'bank_transfer', account_name: 'Aline', account_number: '000123456', bank_name: 'BK' },
    verification_documents: [{ label: 'ID', url: 'https://example.com/id.pdf' }],
    ...extra,
  };
};

test('start-up creates only the missing defaults, reuses equivalents and existing ones, and is idempotent', async () => {
  const first = await ensureTypeCategories();
  assert.deepEqual(first.reused, ['Beverages → Drinks'], 'Beverages is the existing Drinks, not a duplicate');
  assert.ok(!first.created.includes('Breads'), 'existing Bakery categories are reused');
  assert.ok(!first.created.includes('Beverages'));
  for (const name of ['Restaurant', 'Prepared Meals', 'Coffee & Tea', 'Snacks', 'Catering', 'Street Food', 'Signature Meals', 'Meal Prep', 'Juices', 'Smoothies', 'General Food']) {
    assert.ok(first.created.includes(name), `${name} created`);
  }
  const prepared = await models.Category.findOne({ name: 'Prepared Meals' }).lean();
  assert.deepEqual(prepared.vendor_types.sort(), ['caterer', 'chef', 'food_truck', 'home_cook', 'meal_prep', 'restaurant']);
  const drinks = await models.Category.findOne({ name: 'Drinks' }).lean();
  assert.equal(drinks.vendor_types, undefined, 'the existing general Drinks category is not re-tagged');

  const again = await ensureTypeCategories();
  assert.equal(again.created.length, 0);
  const names = (await models.Category.find({}, { name: 1 }).lean()).map((c) => c.name.toLowerCase());
  assert.equal(new Set(names).size, names.length, 'no duplicate categories');
});

test('every vendor type gets its mapped categories, as real category ids', async () => {
  const expected = {
    home_cook: ['Restaurant', 'Prepared Meals'],
    restaurant: ['Restaurant', 'Prepared Meals'],
    cafe: ['Coffee & Tea', 'Snacks'],
    bakery: ['Breads', 'Pastries', 'Cakes', 'Cookies'],
    caterer: ['Catering', 'Prepared Meals'],
    food_truck: ['Street Food', 'Snacks', 'Prepared Meals'],
    chef: ['Signature Meals', 'Prepared Meals'],
    meal_prep: ['Meal Prep', 'Prepared Meals'],
    juice_drinks: ['Juices', 'Smoothies', 'Drinks'],
    other: ['General Food'],
  };
  assert.deepEqual(Object.keys(DEFAULT_FOOD_CATEGORIES).sort(), Object.keys(expected).sort(), 'all 10 vendor types are mapped');
  for (const [type, names] of Object.entries(expected)) {
    const { food_categories: got, food_category_ids: ids } = await vendorCategoryService.fieldsFor(type);
    assert.deepEqual(got, names, type);
    const stored = await models.Category.find({ _id: { $in: ids } }, { name: 1 }).lean();
    assert.equal(stored.length, names.length, `${type}: ids point at existing categories`);
  }
});

test('registration assigns the type’s categories automatically; categories sent by the client are ignored', async () => {
  const res = await h.api('POST', '/vendor/auth/register', {
    body: registerBody('bakery', { food_categories: ['Fast Food', 'Seafood that does not exist'] }),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const vendor = await models.Vendor.findOne({ phone: { $regex: /./ }, name: 'Auto bakery kitchen' }).lean();
  assert.deepEqual(vendor.food_categories, ['Breads', 'Pastries', 'Cakes', 'Cookies']);
  const breads = await models.Category.findOne({ name: 'Breads' }).lean();
  assert.ok(vendor.food_category_ids.some((id) => String(id) === String(breads._id)), 'the existing Breads record is linked');

  // No categories in the request at all: registration still works.
  const noCategories = await h.api('POST', '/vendor/auth/register', { body: registerBody('cafe') });
  assert.equal(noCategories.status, 201, JSON.stringify(noCategories.body));
  const cafe = await models.Vendor.findOne({ name: 'Auto cafe kitchen' }).lean();
  assert.deepEqual(cafe.food_categories, ['Coffee & Tea', 'Snacks']);
});

test('the vendor types list shows each type’s automatic categories (registration preview)', async () => {
  const res = await h.api('GET', '/vendors/types');
  assert.equal(res.status, 200);
  const juice = res.body.vendor_types.find((type) => type.code === 'juice_drinks');
  assert.deepEqual(juice.default_categories.map((c) => c.name), ['Juices', 'Smoothies', 'Drinks']);
  assert.ok(juice.default_categories.every((c) => c.id));
});

test('changing a kitchen’s type gives it the new type’s categories', async () => {
  const { vendor } = await h.createKitchen({ name: 'Type change kitchen', verification_status: 'pending', ...(await vendorCategoryService.fieldsFor('restaurant')) });
  await adminVendorService.setType(String(vendor._id), { vendor_type: 'caterer' }, null);
  const after = await models.Vendor.findById(vendor._id).lean();
  assert.deepEqual(after.food_categories, ['Catering', 'Prepared Meals']);
});

test('a category an admin hid is not assigned; renamed defaults fall back to the type’s tagged categories', async () => {
  await models.Category.updateOne({ name: 'Snacks' }, { $set: { is_active: false } });
  assert.deepEqual((await vendorCategoryService.fieldsFor('cafe')).food_categories, ['Coffee & Tea']);
  await models.Category.updateOne({ name: 'Snacks' }, { $set: { is_active: true } });

  await models.Category.updateOne({ name: 'General Food' }, { $set: { name: 'Everything Else' } });
  assert.deepEqual((await vendorCategoryService.fieldsFor('other')).food_categories, ['Everything Else']);
  await models.Category.updateOne({ name: 'Everything Else' }, { $set: { name: 'General Food' } });
});

test('kitchens with no categories get their defaults at start-up; others are left alone', async () => {
  const { vendor: empty } = await h.createKitchen({ name: 'Empty kitchen', vendor_type: 'chef', food_category_ids: [], food_categories: [] });
  const localFood = await models.Category.findOne({ name: 'Local Food' }).lean();
  const { vendor: chosen } = await h.createKitchen({ name: 'Chosen kitchen', vendor_type: 'chef', food_category_ids: [localFood._id], food_categories: ['Local Food'] });
  await vendorCategoryService.backfillMissing();
  assert.deepEqual((await models.Vendor.findById(empty._id).lean()).food_categories, ['Signature Meals', 'Prepared Meals']);
  assert.deepEqual((await models.Vendor.findById(chosen._id).lean()).food_categories, ['Local Food']);
});
