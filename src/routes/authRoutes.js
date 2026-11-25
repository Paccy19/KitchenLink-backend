const { Router } = require('express');
const rateLimit = require('../middleware/rateLimit');
const { sessionHandlers } = require('../utils/sessions');
const { Customer } = require('../models');
const authController = require('../controllers/authController');
const requireAuth = require('../middleware/requireAuth');
const upload = require('../middleware/upload');
const asyncHandler = require('../utils/asyncHandler');

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
router.post('/auth/login/send-otp', authLimit, authController.sendUnifiedLoginOtp);
router.post('/auth/login/verify-otp', authLimit, authController.verifyUnifiedLoginOtp);
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

// A new phone or email only counts once its code is verified (the current
// one stays until then). Same per-IP limit as sign-in.
const authService = require('../services/authService');
router.post('/auth/me/phone/send-code', authLimit, requireAuth, asyncHandler(async (req, res) => res.json(await authService.startPhoneChange(req.customer, req.body || {}))));
router.post('/auth/me/phone/verify', authLimit, requireAuth, asyncHandler(async (req, res) => res.json(await authService.confirmPhoneChange(req.customer, req.body || {}))));
router.post('/auth/me/email/send-code', authLimit, requireAuth, asyncHandler(async (req, res) => res.json(await authService.startEmailVerification(req.customer, req.body || {}))));
router.post('/auth/me/email/verify', authLimit, requireAuth, asyncHandler(async (req, res) => res.json(await authService.confirmEmailVerification(req.customer, req.body || {}))));

module.exports = router;
