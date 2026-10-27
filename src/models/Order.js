const mongoose = require('mongoose');
const timestamps = require('./timestamps');
const config = require('../config');

// A delivery address is only needed when the order is delivered.
function requiredForDelivery() {
  return this.fulfillment !== 'pickup';
}

const orderSchema = new mongoose.Schema(
  {
    order_number: { type: String, required: true, unique: true },
    customer_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
    },
    vendor_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      required: true,
    },
    items: [
      {
        // Null on big-event orders: their one line is the kitchen's event plate.
        menu_item_id: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'MenuItem',
          default: null,
        },
        name: { type: String, required: true },
        price_rwf: { type: Number, required: true },
        quantity: { type: Number, required: true, min: 1 },
        // Big-event orders (Big Event button): what the customer booked from the
    // kitchen's event offer, kept as it was when they ordered.
    event: {
      guests: { type: Number, min: 1, default: null },
      price_per_plate_rwf: { type: Number, min: 0, default: null },
      menu: [{ type: String }],
      portion: { type: String, default: '' },
      service_style_label: { type: String, default: '' },
      service_details: { type: String, default: '' },
      delivery_details: { type: String, default: '' },
    },
    // Paid in two parts (big events): the deposit when ordering, the balance
    // by balance_due_at (a day before the event). payment_status is 'paid'
    // once the deposit is in; balance_paid_at says the rest is paid too.
    deposit: {
      deposit_rwf: { type: Number, min: 0, default: null },
      balance_rwf: { type: Number, min: 0, default: null },
      balance_due_at: { type: Date, default: null },
      balance_paid_at: { type: Date, default: null },
      // Balance reminders already sent ('due_soon', 'due_today', 'overdue').
      reminders_sent: [{ type: String }],
    },
    // What the customer has actually paid (set on two-part orders; the others
    // pay total_rwf at once). Refunds send back this much.
    amount_paid_rwf: { type: Number, min: 0, default: null },
    subtotal_rwf: { type: Number, required: true },
        image_url: { type: String, default: '' },
        options: [
          {
            option_id: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItemOption' },
            group_name: { type: String, default: 'Options' },
            name: { type: String, required: true },
            additional_price_rwf: { type: Number, min: 0, default: 0 },
          },
        ],
      },
    ],
    subtotal_rwf: { type: Number, required: true },
    delivery_fee_rwf: { type: Number, required: true },
    // Road distance kitchen -> drop-off used to price delivery at checkout.
    delivery_distance_km: { type: Number, min: 0, default: null },
    delivery_distance_source: { type: String, enum: ['google', 'estimate', null], default: null },
    total_rwf: { type: Number, required: true },
    // 'delivery': a delivery worker brings it. 'pickup': the customer collects
    // it at the kitchen — no delivery fee, no delivery worker, and the vendor
    // completes the order with the customer's pickup code.
    fulfillment: {
      type: String,
      enum: config.orders.fulfillmentModes,
      default: 'delivery',
    },
    // Pickup orders: the address is not needed (only `note` is kept).
    delivery_location: {
      address: { type: String, required: requiredForDelivery },
      note: { type: String, default: '' },
      neighborhood: { type: String, default: '' },
      latitude: { type: Number, required: requiredForDelivery },
      longitude: { type: Number, required: requiredForDelivery },
    },
    // Pickup orders: code sent to the customer when the food is ready; the
    // vendor enters it to confirm the customer collected the order.
    pickup_code: { type: String, default: '', select: false },
    pickup_code_sent_at: { type: Date, default: null },
    pickup_code_attempts: { type: Number, min: 0, default: 0 },
    collected_at: { type: Date, default: null },
    payment_method: {
      type: String,
      enum: config.orders.paymentMethods.map((m) => m.code),
      required: true,
    },
    payment_status: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded'],
      default: 'pending',
    },
    // Payer details captured at checkout: phone for mobile wallets, card for cards.
    payment_details: {
      phone: { type: String, default: '' },
      // Masked: only the last 4 digits ("•••• 1234"), never the full number.
      card_number: { type: String, default: '' },
      card_expiry: { type: String, default: '' },
    },
    // Order timing: immediate (ASAP), scheduled (customer-picked slot) or
    // preorder (against a vendor's announced special). scheduled_for is the
    // intended delivery time; special_text snapshots the vendor announcement.
    order_type: {
      type: String,
      enum: config.orders.orderTypes,
      default: 'immediate',
    },
    scheduled_for: { type: Date, default: null },
    special_text: { type: String, default: '' },
    status: {
      type: String,
      enum: config.orders.statuses,
      default: 'placed',
    },
    status_history: [
      {
        status: { type: String, required: true },
        at: { type: Date, default: Date.now },
        note: { type: String, default: '' },
      },
    ],
    rider: {
      name: { type: String },
      phone: { type: String },
    },
    // Delivery leg (set automatically when the order is ready for pickup).
    driver_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Driver',
      default: null,
    },
    delivery_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Delivery',
      default: null,
    },
    eta_minutes: { type: Number },
    estimated_delivery_at: { type: Date },
    picked_up_at: { type: Date },
    delivered_at: { type: Date },
    completed_at: { type: Date },
    cancelled_at: { type: Date },
    cancel_reason: { type: String, default: '' },
    // Settlement snapshot. Captured when the customer pays (funds held by the
    // platform) and released to the vendor/rider when the order completes.
    // Commission is calculated on the food subtotal only, never the delivery
    // fee: the vendor receives subtotal - commission, the rider receives the
    // full delivery fee.
    commission_percent: { type: Number, min: 0, max: 100, default: 0 },
    commission_rwf: { type: Number, min: 0, default: 0 },
    vendor_payout_rwf: { type: Number, min: 0, default: 0 },
    rider_payout_rwf: { type: Number, min: 0, default: 0 },
    settlement_status: {
      type: String,
      enum: ['unpaid', 'held', 'settled', 'refunded'],
      default: 'unpaid',
    },
    settled_at: { type: Date, default: null },
    // Set when the delivery fee is allocated to the rider who delivered it.
    // Until then the fee stays held (e.g. no rider has delivered the order).
    rider_payout_settled_at: { type: Date, default: null },
  },
  { timestamps }
);

orderSchema.index({ customer_id: 1, created_at: -1 });
orderSchema.index({ vendor_id: 1, status: 1 });
orderSchema.index({ vendor_id: 1, completed_at: -1 });
orderSchema.index({ status: 1, created_at: -1 });
orderSchema.index({ driver_id: 1, status: 1 });
orderSchema.index({ order_type: 1, scheduled_for: 1 });
// "Money still held": only orders that can still hold money (see heldTotal).
orderSchema.index({ settlement_status: 1, rider_payout_settled_at: 1 });

module.exports = mongoose.model('Order', orderSchema);
