const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/testServer');

let models;

before(async () => {
  await h.start();
  models = require('../../src/models');
});

after(() => h.stop());

test('customer categories follow available menu items from live kitchens', async () => {
  const [available, unavailable, closed, inactiveVendor, inactiveCategory] =
    await models.Category.insertMany([
      { name: 'Available category', is_active: true },
      { name: 'Unavailable category', is_active: true },
      { name: 'Closed kitchen category', is_active: true },
      { name: 'Inactive kitchen category', is_active: true },
      { name: 'Inactive category', is_active: false },
    ]);

  await h.createKitchen({
    name: 'Unavailable offering kitchen',
    dishes: [{ name: 'Unavailable offering', price_rwf: 1000, category_id: unavailable._id, is_available: false }],
  });
  await h.createKitchen({
    name: 'Closed category kitchen',
    is_open: false,
    dishes: [{ name: 'Closed kitchen offering', price_rwf: 1000, category_id: closed._id }],
  });
  await h.createKitchen({
    name: 'Inactive category kitchen',
    is_active: false,
    dishes: [{ name: 'Inactive kitchen offering', price_rwf: 1000, category_id: inactiveVendor._id }],
  });
  await h.createKitchen({
    name: 'Inactive category offering kitchen',
    dishes: [{ name: 'Inactive category offering', price_rwf: 1000, category_id: inactiveCategory._id }],
  });

  const getCategoryIds = async () => {
    const response = await h.api('GET', '/home/categories');
    assert.equal(response.status, 200);
    return response.body.categories.map((category) => category.id);
  };
  const getFeedCategoryIds = async () => {
    const response = await h.api('GET', '/home/feed');
    assert.equal(response.status, 200);
    return response.body.categories.map((category) => category.id);
  };

  let ids = await getCategoryIds();
  assert.deepEqual(ids, [], 'empty and ineligible categories are hidden');

  const first = await h.createKitchen({
    name: 'Available category kitchen one',
    dishes: [{ name: 'First offering', price_rwf: 1000, category_id: available._id }],
  });
  ids = await getCategoryIds();
  assert.deepEqual(ids, [String(available._id)]);
  assert.deepEqual(await getFeedCategoryIds(), ids);

  const second = await h.createKitchen({
    name: 'Available category kitchen two',
    dishes: [{ name: 'Second offering', price_rwf: 1000, category_id: available._id }],
  });
  await models.MenuItem.updateOne(
    { _id: first.items[0]._id },
    { $set: { is_available: false } }
  );
  ids = await getCategoryIds();
  assert.deepEqual(ids, [String(available._id)], 'another kitchen still has an available offering');

  await models.MenuItem.updateOne(
    { _id: second.items[0]._id },
    { $set: { deleted_at: new Date() } }
  );
  ids = await getCategoryIds();
  assert.deepEqual(ids, [], 'category disappears when its last live offering is removed');
  assert.deepEqual(await getFeedCategoryIds(), ids);
});
