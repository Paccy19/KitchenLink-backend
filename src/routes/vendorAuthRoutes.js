const { Router } = require('express');
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
router.post('/change-password', requireVendorAuth, vendorAuthController.changePassword);

module.exports = router;
