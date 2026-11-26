const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;
const actor = { type: { type: String, default: null }, id: { type: String, default: null }, name: { type: String, default: '' } };

/**
 * Something to pack, linked to its order:
 *   leftover   the guest's unfinished food (already bought: no new charge)
 *   takeaway   items of a dine-in order the guest takes away instead
 *   delivery   a whole delivery order before dispatch (when packing is on)
 *   pickup     a takeaway (pickup) order before the customer collects it
 * requested -> packed -> handed_over (or cancelled).
 */
const packingTaskSchema = new mongoose.Schema(
  {
    vendor_id: { type: ObjectId, ref: 'Vendor', required: true },
    order_id: { type: ObjectId, ref: 'Order', required: true },
    order_number: { type: String, default: '' },
    session_id: { type: ObjectId, ref: 'TableSession', default: null },
    table_label: { type: String, default: '' },
    kind: { type: String, enum: ['leftover', 'takeaway', 'delivery', 'pickup'], required: true },
    items: [
      {
        _id: false,
        item_id: { type: ObjectId, required: true },
        name: { type: String, required: true },
        quantity: { type: Number, min: 0, required: true },
        packed: { type: Boolean, default: false },
      },
    ],
    instructions: { type: String, default: '', trim: true },
    status: { type: String, enum: ['requested', 'packed', 'handed_over', 'cancelled'], default: 'requested' },
    requested_by: actor,
    packed_by: actor,
    handed_over_by: actor,
    packed_at: { type: Date, default: null },
    handed_over_at: { type: Date, default: null },
    issue: { type: String, default: '', trim: true },
  },
  { timestamps }
);

packingTaskSchema.index({ vendor_id: 1, status: 1, created_at: 1 });
packingTaskSchema.index({ order_id: 1 });

module.exports = mongoose.model('PackingTask', packingTaskSchema);
