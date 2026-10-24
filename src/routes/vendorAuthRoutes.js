const { Router } = require('express');
const rateLimit = require('../middleware/rateLimit');
const { sessionHandlers } = require('../utils/sessions');
const { Vendor } = require('../models');
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
router.get('/me', requireVendorAuth, vendorAuthController.me);
// Sign out: this device, or every device (the token stops working at once).
const vendorSessions = sessionHandlers(Vendor, 'vendor');
router.post('/logout', requireVendorAuth, vendorSessions.logout);
router.post('/logout-all', requireVendorAuth, vendorSessions.logoutAll);
router.post('/change-password', requireVendorAuth, vendorAuthController.changePassword);

module.exports = router;
