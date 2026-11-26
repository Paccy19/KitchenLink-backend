const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;

/** A guest's rating and comment after an order; public ones show as reviews. */
const feedbackSchema = new mongoose.Schema(
  {
    vendor_id: { type: ObjectId, ref: 'Vendor', required: true },
    order_id: { type: ObjectId, ref: 'Order', required: true, unique: true },
    order_number: { type: String, default: '' },
    table_label: { type: String, default: '' },
    customer_id: { type: ObjectId, ref: 'Customer', default: null },
    name: { type: String, default: '' },
    rating: { type: Number, min: 1, max: 5, required: true },
    comment: { type: String, default: '', trim: true },
    // The guest agreed to show it on the kitchen's page.
    is_public: { type: Boolean, default: false },
    reply: { type: String, default: '', trim: true },
    replied_by: { type: String, default: '' },
    replied_at: { type: Date, default: null },
  },
  { timestamps }
);

feedbackSchema.index({ vendor_id: 1, created_at: -1 });

module.exports = mongoose.model('Feedback', feedbackSchema);
