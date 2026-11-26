const mongoose = require('mongoose');
const timestamps = require('./timestamps');

/** The kitchen's audit log: who (owner or which employee) did what. Never edited. */
const kitchenActivitySchema = new mongoose.Schema(
  {
    vendor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
    actor_type: { type: String, enum: ['owner', 'staff', 'customer', 'system'], required: true },
    actor_id: { type: String, default: null },
    actor_name: { type: String, default: '' },
    action: { type: String, required: true },
    target_type: { type: String, default: '' },
    target_id: { type: String, default: '' },
    summary: { type: String, default: '' },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    department_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null },
  },
  { timestamps }
);

kitchenActivitySchema.index({ vendor_id: 1, created_at: -1 });
kitchenActivitySchema.index({ vendor_id: 1, actor_id: 1, created_at: -1 });

module.exports = mongoose.model('KitchenActivity', kitchenActivitySchema);
