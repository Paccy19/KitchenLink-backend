const { Router } = require('express');
const { sessionHandlers } = require('../utils/sessions');
const { Driver } = require('../models');
const requireDriverAuth = require('../middleware/requireDriverAuth');
const driverAuthController = require('../controllers/driverAuthController');

const router = Router();

router.post('/register', driverAuthController.register);
router.post('/send-otp', driverAuthController.sendOtp);
router.post('/verify-otp', driverAuthController.verifyOtp);
router.get('/me', requireDriverAuth, driverAuthController.me);
// Sign out: this device, or every device (the token stops working at once).
const driverSessions = sessionHandlers(Driver, 'driver');
router.post('/logout', requireDriverAuth, driverSessions.logout);
router.post('/logout-all', requireDriverAuth, driverSessions.logoutAll);
router.post('/change-password', requireDriverAuth, driverAuthController.changePassword);

module.exports = router;