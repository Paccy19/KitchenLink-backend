const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;

/**
 * An employee of one kitchen. The kitchen administrator creates the account
 * and gives the employee a username and password (or the employee signs in
 * with a code sent to their phone or email). Either way they get a kitchen
 * session that carries their staff id: every request is checked against their roles.
 */
const kitchenStaffSchema = new mongoose.Schema(
  {
    vendor_id: { type: ObjectId, ref: 'Vendor', required: true, index: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true, default: null },
    email: { type: String, trim: true, lowercase: true, default: null },
    // Sign-in name chosen by the kitchen (lower case, unique on the platform).
    username: { type: String, trim: true, lowercase: true, default: null },
    password_hash: { type: String, select: false, default: null },
    password_set_at: { type: Date, default: null },
    job_title: { type: String, default: '', trim: true },
    role_ids: [{ type: ObjectId, ref: 'KitchenRole' }],
    department_ids: [{ type: ObjectId, ref: 'Department' }],
    // Kitchen administrator: full control, like the kitchen account itself.
    is_admin: { type: Boolean, default: false },
    is_active: { type: Boolean, default: true },
    last_login_at: { type: Date, default: null },
    sessions_valid_after: { type: Date, default: null },
    sessions_kept_jti: { type: String, default: null },
    // Kept true until removed, so the unique indexes ignore removed staff.
    is_current: { type: Boolean, default: true },
    deleted_at: { type: Date, default: null },
  },
  { timestamps }
);

// One current staff account per phone / email across the platform: the
// sign-in code then always opens the right kitchen.
kitchenStaffSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { is_current: true, phone: { $type: 'string' } } });
kitchenStaffSchema.index({ username: 1 }, { unique: true, partialFilterExpression: { is_current: true, username: { $type: 'string' } } });
kitchenStaffSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { is_current: true, email: { $type: 'string' } } });

module.exports = mongoose.model('KitchenStaff', kitchenStaffSchema);
