const { Order } = require('../models');
const { pool } = require('../db/postgres');

/**
 * Orders saved before card numbers were masked hold the full number. This
 * keeps only the last 4 digits ("•••• 1234") in MongoDB and in the PostgreSQL
 * mirror. Safe to run on every start: masked numbers are left alone.
 * Returns how many MongoDB orders were changed.
 */
async function maskStoredCardNumbers() {
  const orders = await Order.find({ 'payment_details.card_number': /^\d{5,}$/ })
    .select('payment_details.card_number')
    .lean();
  for (const order of orders) {
    await Order.updateOne(
      { _id: order._id },
      { $set: { 'payment_details.card_number': `•••• ${order.payment_details.card_number.slice(-4)}` } }
    );
  }

  // The mirror is optional: skip quietly when it isn't reachable.
  try {
    await pool.query(
      `UPDATE orders
          SET payment_details = (payment_details::jsonb
                || jsonb_build_object('card_number', '•••• ' || right(payment_details->>'card_number', 4)))::json
        WHERE payment_details->>'card_number' ~ '^[0-9]{5,}$'`
    );
  } catch {
    /* no mirror, or no orders table yet */
  }
  return orders.length;
}

module.exports = maskStoredCardNumbers;
