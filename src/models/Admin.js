const mongoose = require('mongoose');
const timestamps = require('./timestamps');
const { OWNER_ROLE, TEAM_ROLES, LEGACY_ROLES, ALL_PERMISSIONS } = require('../config/adminAccess');

/**
 * Admin accounts for the Admin Panel. Kept separate from Customer/Vendor/Driver
 * so each role keeps its own login surface and JWT audience.
 *
 * The owner is `super_admin`. Team members are invited by the owner with a
 * role (see config/adminAccess.js): they start `invited` and set their own
 * password from the emailed link, then become `active`.
 */
const ADMIN_ROLES = [OWNER_ROLE, ...TEAM_ROLES, ...Object.keys(LEGACY_ROLES)];
const ADMIN_PERMISSIONS = ALL_PERMISSIONS;

const adminSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, default: '' },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
      index: true,
    },
    password_hash: { type: String, select: false },
    role: { type: String, enum: ADMIN_ROLES, default: OWNER_ROLE },
    // Not used for access any more: a member's role decides their permissions.
    permissions: [{ type: String }],
    status: { type: String, enum: ['invited', 'active'], default: 'active' },
    is_active: { type: Boolean, default: true },
    // Verified phone for SMS sign-in codes and money-action confirmations.
    // Unique among admins once set (see the partial index below).
    phone: { type: String, trim: true, default: '' },
    two_factor_enabled: { type: Boolean, default: false },
    // Invitation (only the hash of the emailed token is stored).
    invite_token_hash: { type: String, select: false, default: null },
    invite_expires_at: { type: Date, default: null },
    invited_at: { type: Date, default: null },
    invited_by: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    accepted_at: { type: Date, default: null },
    deactivated_at: { type: Date, default: null },
    last_login_at: { type: Date },
    // Soft delete.
    deleted_at: { type: Date, default: null },
  },
  { timestamps }
);

adminSchema.index(
  { phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $gt: '' } } }
);

module.exports = mongoose.model('Admin', adminSchema);
module.exports.ADMIN_ROLES = ADMIN_ROLES;
module.exports.ADMIN_PERMISSIONS = ADMIN_PERMISSIONS;
