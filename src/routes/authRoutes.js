const { Router } = require('express');
const rateLimit = require('../middleware/rateLimit');
const { sessionHandlers } = require('../utils/sessions');
const { Customer } = require('../models');
const authController = require('../controllers/authController');
const requireAuth = require('../middleware/requireAuth');
const upload = require('../middleware/upload');

const router = Router();

// Public sign-in: at most 20 requests a minute per IP.
const authLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  code: 'AUTH_RATE_LIMITED',
  message: 'Too many sign-in attempts from this network. Please wait a minute and try again.',
});
router.post('/auth/send-otp', authLimit, authController.sendOtp);
router.post('/auth/verify-otp', authLimit, authController.verifyOtp);
router.get('/auth/me', requireAuth, authController.me);
// Sign out: this device, or every device (the token stops working at once).
const customerSessions = sessionHandlers(Customer, 'customer');
router.post('/auth/logout', requireAuth, customerSessions.logout);
router.post('/auth/logout-all', requireAuth, customerSessions.logoutAll);
router.patch(
  '/auth/me/profile',
  requireAuth,
  upload.single('profile_image'),
  authController.updateProfile
);
router.put('/auth/me/location', requireAuth, authController.updateLocation);

module.exports = router;
