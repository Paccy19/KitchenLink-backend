const mongoose = require('mongoose');
const timestamps = require('./timestamps');
const config = require('../config');

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
        menu_item_id: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'MenuItem',
          required: true,
        },
        name: { type: String, required: true },
        price_rwf: { type: Number, required: true },
        quantity: { type: Number, required: true, min: 1 },
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
    total_rwf: { type: Number, required: true },
    delivery_location: {
      address: { type: String, required: true },
      note: { type: String, default: '' },
      neighborhood: { type: String, default: '' },
      latitude: { type: Number, required: true },
      longitude: { type: Number, required: true },
    },
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
      card_number: { type: String, default: '' },
      card_expiry: { type: String, default: '' },
    },
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
  },
  { timestamps }
);

orderSchema.index({ customer_id: 1, created_at: -1 });
orderSchema.index({ vendor_id: 1, status: 1 });
orderSchema.index({ vendor_id: 1, completed_at: -1 });
orderSchema.index({ status: 1, created_at: -1 });
orderSchema.index({ driver_id: 1, status: 1 });

module.exports = mongoose.model('Order', orderSchema);
