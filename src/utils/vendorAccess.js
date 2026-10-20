const config = require('../config');
const ApiError = require('./ApiError');

const BLOCKED = {
  suspended: {
    code: 'VENDOR_SUSPENDED',
    message: 'Your vendor account has been suspended. Contact the support team to resolve it.',
    reasonField: 'suspension_reason',
  },
  rejected: {
    code: 'VENDOR_REJECTED',
    message: 'Your vendor application was rejected. Contact the support team to resolve it.',
    reasonField: 'rejection_reason',
  },
};

/**
 * Throws a 403 for suspended or rejected vendors. The error details carry the
 * admin's reason and the support contact so the login page can explain why
 * the account is blocked and who to call.
 */
function assertVendorNotBlocked(vendor) {
  const status = vendor?.verification_status;
  const blocked = BLOCKED[status];
  if (!blocked) return;
  throw new ApiError(403, blocked.code, blocked.message, {
    status,
    reason: vendor[blocked.reasonField] || '',
    ...(status === 'suspended' && vendor.suspended_at
      ? { suspended_at: vendor.suspended_at }
      : {}),
    support_phone: config.support.phone,
    support_email: config.support.email,
  });
}

/**
 * Throws a 403 while the vendor's documents are still under review. Pending
 * vendors may sign in and look around, but cannot take any vendor action.
 */
function assertVendorApproved(vendor) {
  if (vendor?.verification_status !== 'pending') return;
  throw new ApiError(
    403,
    'VENDOR_PENDING_REVIEW',
    'Your documents are still under review. You can use the Vendor Dashboard once your account is approved.',
    { status: 'pending' }
  );
}

module.exports = { assertVendorNotBlocked, assertVendorApproved };
