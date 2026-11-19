const { Customer, Order } = require('../models');
const { normalizePhone } = require('../utils/validators');

const NORMALIZED = /^\+2507[2389]\d{7}$/;

/**
 * Customers whose phones are really the same number written differently
 * (07…, 2507…, +2507…), or that can't be read as a Rwandan number. Read only.
 * Returns { duplicates: [{ phone, customers: [{ id, name, stored, orders, created_at }] }],
 *           invalid: [{ id, stored }], toNormalize: [{ id, from, to }] }.
 */
async function findPhoneProblems() {
  const customers = await Customer.find(
    { phone_number: { $type: 'string' }, erased_at: null },
    { name: 1, phone_number: 1, created_at: 1 }
  ).lean();
  const groups = new Map();
  const invalid = [];
  for (const customer of customers) {
    if (customer.phone_number.startsWith('erased-')) continue;
    let phone;
    try {
      phone = normalizePhone(customer.phone_number);
    } catch {
      invalid.push({ id: String(customer._id), stored: customer.phone_number });
      continue;
    }
    if (!groups.has(phone)) groups.set(phone, []);
    groups.get(phone).push(customer);
  }

  const duplicates = [];
  const toNormalize = [];
  for (const [phone, members] of groups) {
    if (members.length > 1) {
      const withOrders = await Promise.all(
        members.map(async (customer) => ({
          id: String(customer._id),
          name: customer.name,
          stored: customer.phone_number,
          orders: await Order.countDocuments({ customer_id: customer._id }),
          created_at: customer.created_at,
        }))
      );
      duplicates.push({ phone, customers: withOrders });
    } else if (members[0].phone_number !== phone && !NORMALIZED.test(members[0].phone_number)) {
      toNormalize.push({ id: String(members[0]._id), from: members[0].phone_number, to: phone });
    }
  }
  return { duplicates, invalid, toNormalize };
}

/**
 * Run at start-up (idempotent):
 *  1. The old phone index required every customer to have a phone. Email
 *     sign-ups may not have one yet, so it is replaced by one that is unique
 *     only among customers with a phone (`phone_number_unique_when_set`).
 *  2. Phones stored as 07… or 2507… become +2507…, so one number can't be
 *     registered twice in different formats, when that number is used by one
 *     customer only.
 *  3. Numbers shared by several customers are never merged, moved or deleted:
 *     every account, order and sign-in is left exactly as it is, and they are
 *     reported for an admin to sort out with the customers
 *     (`npm run report:customer-phones`). They still can't be registered again.
 */
async function migrateCustomerIdentity() {
  const result = { droppedOldPhoneIndex: false, normalized: 0, duplicates: [], invalid: [] };
  const indexes = await Customer.collection.indexes().catch(() => []);
  if (indexes.some((index) => index.name === 'phone_number_1')) {
    await Customer.collection.dropIndex('phone_number_1');
    result.droppedOldPhoneIndex = true;
  }

  const { duplicates, invalid, toNormalize } = await findPhoneProblems();
  for (const { id, from, to } of toNormalize) {
    // Only if nobody holds the normalized form (checked again, atomically, by the index).
    try {
      const updated = await Customer.updateOne({ _id: id, phone_number: from }, { $set: { phone_number: to } });
      result.normalized += updated.modifiedCount;
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
  }
  await Customer.createIndexes();
  result.duplicates = duplicates;
  result.invalid = invalid;
  return result;
}

module.exports = migrateCustomerIdentity;
module.exports.findPhoneProblems = findPhoneProblems;
