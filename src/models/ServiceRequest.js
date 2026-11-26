const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;

/** A guest at a table asking for something: the waiter, the bill, water … */
const serviceRequestSchema = new mongoose.Schema(
  {
    vendor_id: { type: ObjectId, ref: 'Vendor', required: true },
    table_id: { type: ObjectId, ref: 'DiningTable', required: true },
    table_label: { type: String, default: '' },
    kind: { type: String, enum: ['call_waiter', 'request_bill', 'other'], required: true },
    note: { type: String, default: '', trim: true },
    status: { type: String, enum: ['open', 'acknowledged', 'done'], default: 'open' },
    handled_by: {
      type: { type: String, default: null },
      id: { type: String, default: null },
      name: { type: String, default: '' },
    },
    acknowledged_at: { type: Date, default: null },
    done_at: { type: Date, default: null },
  },
  { timestamps }
);

serviceRequestSchema.index({ vendor_id: 1, status: 1, created_at: -1 });
serviceRequestSchema.index({ table_id: 1, status: 1 });

module.exports = mongoose.model('ServiceRequest', serviceRequestSchema);
