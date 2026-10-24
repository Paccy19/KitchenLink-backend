const { Router } = require('express');
const rateLimit = require('../middleware/rateLimit');
const { sessionHandlers } = require('../utils/sessions');
const { Driver } = require('../models');
const requireDriverAuth = require('../middleware/requireDriverAuth');
const driverAuthController = require('../controllers/driverAuthController');

const router = Router();

// Public sign-in: at most 20 requests a minute per IP.
const authLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  code: 'AUTH_RATE_LIMITED',
  message: 'Too many sign-in attempts from this network. Please wait a minute and try again.',
});
router.post('/register', authLimit, driverAuthController.register);
router.post('/send-otp', authLimit, driverAuthController.sendOtp);
router.post('/verify-otp', authLimit, driverAuthController.verifyOtp);
router.get('/me', requireDriverAuth, driverAuthController.me);
// Sign out: this device, or every device (the token stops working at once).
const driverSessions = sessionHandlers(Driver, 'driver');
router.post('/logout', requireDriverAuth, driverSessions.logout);
router.post('/logout-all', requireDriverAuth, driverSessions.logoutAll);
router.post('/change-password', requireDriverAuth, driverAuthController.changePassword);

module.exports = router;