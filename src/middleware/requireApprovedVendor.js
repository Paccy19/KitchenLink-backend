const { assertVendorApproved } = require('../utils/vendorAccess');

/**
 * Use after `requireVendorAuth` on routes that perform a vendor action
 * (menu, orders, wallet, store settings). Pending vendors are refused.
 */
const requireApprovedVendor = (req, res, next) => {
  try {
    assertVendorApproved(req.vendor);
    next();
  } catch (error) {
    next(error);
  }
};

module.exports = requireApprovedVendor;
