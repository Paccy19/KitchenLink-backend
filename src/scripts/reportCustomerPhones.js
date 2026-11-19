/**
 * Lists customers sharing one phone number (written in different formats) or
 * with a phone that isn't a valid Rwandan number. Read only: nothing is
 * changed. `npm run report:customer-phones`
 *
 * Sorting one out (manually, with the customers): decide whose number it is
 * (ask them to prove it with a sign-in code), then give the other account its
 * own number in the admin panel or contact the customer. Never merge the
 * accounts: each keeps its orders, payments and refunds.
 */
const mongoose = require('mongoose');
const config = require('../config');
const { findPhoneProblems } = require('./migrateCustomerIdentity');

(async () => {
  await mongoose.connect(config.mongoUri);
  try {
    const { duplicates, invalid, toNormalize } = await findPhoneProblems();
    console.log(`Shared phone numbers: ${duplicates.length}`);
    for (const group of duplicates) {
      console.log(`\n${group.phone}`);
      for (const customer of group.customers) {
        console.log(`  customer ${customer.id}  "${customer.name}"  stored as ${customer.stored}  orders: ${customer.orders}  since ${customer.created_at?.toISOString?.() || '?'}`);
      }
    }
    console.log(`\nInvalid phone numbers: ${invalid.length}`);
    for (const row of invalid) console.log(`  customer ${row.id}  stored as ${row.stored}`);
    console.log(`\nWaiting to be normalized at the next start: ${toNormalize.length}`);
  } finally {
    await mongoose.disconnect();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
