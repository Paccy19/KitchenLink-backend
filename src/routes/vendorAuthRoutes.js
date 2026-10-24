const { Router } = require('express');
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

router.post('/register', registrationFiles, vendorAuthController.register);
router.post('/send-otp', vendorAuthController.sendOtp);
router.post('/verify-otp', vendorAuthController.verifyOtp);
router.get('/me', requireVendorAuth, vendorAuthController.me);
// Sign out: this device, or every device (the token stops working at once).
const vendorSessions = sessionHandlers(Vendor, 'vendor');
router.post('/logout', requireVendorAuth, vendorSessions.logout);
router.post('/logout-all', requireVendorAuth, vendorSessions.logoutAll);
router.post('/change-password', requireVendorAuth, vendorAuthController.changePassword);

module.exports = router;
