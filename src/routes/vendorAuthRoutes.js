const { Router } = require('express');
const rateLimit = require('../middleware/rateLimit');
const { sessionHandlers } = require('../utils/sessions');
const { Vendor, KitchenStaff } = require('../models');
const config = require('../config');
const requireVendorAuth = require('../middleware/requireVendorAuth');
const upload = require('../middleware/upload');
const vendorAuthController = require('../controllers/vendorAuthController');

const router = Router();

const registrationFiles = upload.registration.fields([
  { name: 'banner_image', maxCount: 1 },
  { name: 'documents', maxCount: config.vendor.uploads.maxDocuments },
]);

// Public sign-in: at most 20 requests a minute per IP.
const authLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  code: 'AUTH_RATE_LIMITED',
  message: 'Too many sign-in attempts from this network. Please wait a minute and try again.',
});
router.post('/register', authLimit, registrationFiles, vendorAuthController.register);
router.post('/send-otp', authLimit, vendorAuthController.sendOtp);
router.post('/verify-otp', authLimit, vendorAuthController.verifyOtp);
// Kitchen employees: the username and password their administrator gave them.
router.post('/staff-login', authLimit, vendorAuthController.staffLogin);
router.get('/me', requireVendorAuth, vendorAuthController.me);
// Sign out: this device, or every device (the token stops working at once).
// An employee signs out their own sessions, never the kitchen owner's.
const vendorSessions = sessionHandlers(Vendor, 'vendor');
const staffSessions = sessionHandlers(KitchenStaff, 'staff');
const bySession = (name) => (req, res, next) => (req.staff ? staffSessions : vendorSessions)[name](req, res, next);
router.post('/logout', requireVendorAuth, bySession('logout'));
router.post('/logout-all', requireVendorAuth, bySession('logoutAll'));
router.post('/change-password', requireVendorAuth, vendorAuthController.changePassword);

module.exports = router;
