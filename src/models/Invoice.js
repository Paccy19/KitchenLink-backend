const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;

const actor = {
  type: { type: String, enum: ['owner', 'staff', 'system'], default: 'system' },
  id: { type: String, default: null },
  name: { type: String, default: '' },
};

/**
 * One customer bill. A table's invoice gathers every order placed at the
 * table while it is open (one consolidated bill across departments); a
 * marketplace order gets its own, already paid online. Lines keep their
 * department so sales can be reported per department.
 */
const invoiceSchema = new mongoose.Schema(
  {
    vendor_id: { type: ObjectId, ref: 'Vendor', required: true },
    invoice_number: { type: String, required: true },
    order_ids: [{ type: ObjectId, ref: 'Order' }],
    table_id: { type: ObjectId, ref: 'DiningTable', default: null },
    table_label: { type: String, default: '' },
    customer_name: { type: String, default: '' },
    // 'table' (dine-in, in person) or 'order' (one marketplace order, paid online).
    kind: { type: String, enum: ['table', 'order'], required: true },
    // Takes new orders from the table until paid in full or closed.
    is_open: { type: Boolean, default: true },
    lines: [
      {
        order_id: { type: ObjectId, ref: 'Order' },
        order_number: { type: String, default: '' },
        item_id: { type: ObjectId, default: null },
        menu_item_id: { type: ObjectId, ref: 'MenuItem', default: null },
        name: { type: String, required: true },
        department_id: { type: ObjectId, ref: 'Department', default: null },
        department_name: { type: String, default: '' },
        quantity: { type: Number, required: true, min: 1 },
        unit_price_rwf: { type: Number, required: true, min: 0 },
        subtotal_rwf: { type: Number, required: true, min: 0 },
        voided: { type: Boolean, default: false },
      },
    ],
    subtotal_rwf: { type: Number, default: 0, min: 0 },
    delivery_fee_rwf: { type: Number, default: 0, min: 0 },
    discount_rwf: { type: Number, default: 0, min: 0 },
    // Promotions applied (codes and automatic campaigns), worked out from the lines.
    promo_discount_rwf: { type: Number, default: 0, min: 0 },
    promotions: [
      {
        _id: false,
        promotion_id: { type: ObjectId, ref: 'Promotion' },
        name: { type: String, default: '' },
        code: { type: String, default: '' },
        amount_rwf: { type: Number, default: 0, min: 0 },
      },
    ],
    // Loyalty: the kitchen customer on the bill, and points spent on it.
    kitchen_customer_id: { type: ObjectId, ref: 'KitchenCustomer', default: null },
    loyalty_points_redeemed: { type: Number, default: 0, min: 0 },
    loyalty_discount_rwf: { type: Number, default: 0, min: 0 },
    loyalty_points_earned: { type: Number, default: 0, min: 0 },
    // Split and merged bills, and why a bill was cancelled.
    split_from: { type: ObjectId, ref: 'Invoice', default: null },
    merged_into: { type: ObjectId, ref: 'Invoice', default: null },
    cancel_reason: { type: String, default: '' },
    total_rwf: { type: Number, default: 0, min: 0 },
    amount_paid_rwf: { type: Number, default: 0, min: 0 },
    refunded_rwf: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ['unpaid', 'partially_paid', 'paid', 'refunded', 'void'], default: 'unpaid' },
    payments: [
      {
        amount_rwf: { type: Number, required: true, min: 1 },
        method: { type: String, required: true },
        reference: { type: String, default: '' },
        // 'in_person' = taken by the kitchen; 'online' = paid in the app (platform holds it).
        channel: { type: String, enum: ['in_person', 'online'], default: 'in_person' },
        received_by: actor,
        at: { type: Date, default: Date.now },
      },
    ],
    refunds: [
      {
        amount_rwf: { type: Number, required: true, min: 1 },
        method: { type: String, default: 'cash' },
        reason: { type: String, default: '' },
        by: actor,
        at: { type: Date, default: Date.now },
      },
    ],
    notes: { type: String, default: '' },
    created_by: actor,
    paid_at: { type: Date, default: null },
    closed_at: { type: Date, default: null },
  },
  { timestamps }
);

invoiceSchema.index({ vendor_id: 1, invoice_number: 1 }, { unique: true });
invoiceSchema.index({ vendor_id: 1, status: 1, created_at: -1 });
invoiceSchema.index({ vendor_id: 1, table_id: 1, is_open: 1 });
// One open bill per table: two orders at the same moment join the same one.
invoiceSchema.index(
  { vendor_id: 1, table_id: 1 },
  { unique: true, partialFilterExpression: { kind: 'table', is_open: true }, name: 'one_open_bill_per_table' }
);
invoiceSchema.index({ order_ids: 1 });

module.exports = mongoose.model('Invoice', invoiceSchema);
