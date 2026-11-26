const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;

/** A role a kitchen defines for its staff: a named set of permissions (kitchenAccess.js). */
const kitchenRoleSchema = new mongoose.Schema(
  {
    vendor_id: { type: ObjectId, ref: 'Vendor', required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    permissions: [{ type: String }],
    // Limits the role's department permissions to these departments. Empty = across the kitchen.
    department_ids: [{ type: ObjectId, ref: 'Department' }],
    // The starting role it was created from (kitchenAccess.DEFAULT_ROLES key), if any.
    template_key: { type: String, default: null },
    deleted_at: { type: Date, default: null },
  },
  { timestamps }
);

kitchenRoleSchema.index({ vendor_id: 1, deleted_at: 1, name: 1 });

module.exports = mongoose.model('KitchenRole', kitchenRoleSchema);
