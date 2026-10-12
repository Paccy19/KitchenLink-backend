const mongoose = require('mongoose');
const timestamps = require('./timestamps');

/**
 * Admin accounts for the Admin Panel. Kept separate from Customer/Vendor/Driver
 * so each role keeps its own login surface and JWT audience.
 */
const ADMIN_ROLES = ['super_admin', 'operations', 'finance', 'support', 'analyst'];

const ADMIN_PERMISSIONS = [
  'users:read',
  'users:write',
  'vendors:read',
  'vendors:write',
  'orders:read',
  'orders:write',
  'payments:read',
  'payments:write',
  'drivers:read',
  'drivers:write',
  'deliveries:read',
  'deliveries:write',
  'categories:read',
  'categories:write',
  'complaints:read',
  'complaints:write',
  'analytics:read',
  'actions:read',
];

const adminSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
      index: true,
    },
    password_hash: { type: String, select: false },
    role: { type: String, enum: ADMIN_ROLES, default: 'super_admin' },
    // Empty means "all permissions for the role" (super admins).
    permissions: [{ type: String, enum: ADMIN_PERMISSIONS }],
    is_active: { type: Boolean, default: true },
    // Verified phone for SMS sign-in codes and money-action confirmations.
    phone: { type: String, trim: true, default: '' },
    two_factor_enabled: { type: Boolean, default: false },
    last_login_at: { type: Date },
    // Soft delete.
    deleted_at: { type: Date, default: null },
  },
  { timestamps }
);

module.exports = mongoose.model('Admin', adminSchema);
module.exports.ADMIN_ROLES = ADMIN_ROLES;
module.exports.ADMIN_PERMISSIONS = ADMIN_PERMISSIONS;
