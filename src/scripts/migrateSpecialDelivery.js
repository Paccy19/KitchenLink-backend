const { ChatConversation, Vendor, Refund } = require('../models');
const { legacyCoverage } = require('../config/deliveryCoverage');

/**
 * Run at start-up (idempotent):
 *  1. Chats: the old unique { customer_id, vendor_id } index allowed one chat
 *     per pair only. Negotiation chats need one per request, so it is
 *     replaced by { customer_id, vendor_id, special_delivery_request_id }.
 *  2. Kitchens that took big-event deliveries before coverage existed (their
 *     own fee ranges, now replaced by platform pricing) keep delivering:
 *     coverage on, within their farthest range of the kitchen + their district.
 */
async function migrateSpecialDelivery() {
  const result = { droppedChatIndex: false, droppedRefundIndex: false, coverageMigrated: 0 };

  const indexes = await ChatConversation.collection.indexes().catch(() => []);
  if (indexes.some((index) => index.name === 'customer_id_1_vendor_id_1')) {
    await ChatConversation.collection.dropIndex('customer_id_1_vendor_id_1');
    result.droppedChatIndex = true;
  }
  await ChatConversation.createIndexes();

  // 3. Refunds: one per order and kind (a reduced special delivery fee, then
  //    maybe a cancellation) instead of one per order. Old refunds are
  //    cancellations.
  const refundIndexes = await Refund.collection.indexes().catch(() => []);
  if (refundIndexes.some((index) => index.name === 'order_id_1' && index.unique)) {
    await Refund.collection.dropIndex('order_id_1');
    result.droppedRefundIndex = true;
  }
  await Refund.updateMany({ kind: { $exists: false } }, { $set: { kind: 'order_cancelled' } });
  await Refund.createIndexes();

  const legacy = await Vendor.find(
    { 'event_package.enabled': true, delivery_coverage: { $exists: false } },
    { location: 1, event_package: 1 }
  ).lean();
  for (const vendor of legacy) {
    await Vendor.updateOne({ _id: vendor._id, delivery_coverage: { $exists: false } }, { $set: { delivery_coverage: legacyCoverage(vendor) } });
    result.coverageMigrated += 1;
  }
  return result;
}

module.exports = migrateSpecialDelivery;
