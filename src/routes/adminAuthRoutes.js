const { Router } = require('express');
const { sessionHandlers } = require('../utils/sessions');
const { Admin } = require('../models');
const requireAdminAuth = require('../middleware/requireAdminAuth');
const adminAuthController = require('../controllers/adminAuthController');
const asyncHandler = require('../utils/asyncHandler');
const teamService = require('../services/teamService');

const router = Router();

router.post('/login', adminAuthController.login);

// Team invitations (opened from the emailed link; no sign-in yet).
router.get(
  '/invitations/:token',
  asyncHandler(async (req, res) => res.json(await teamService.getInvitation(req.params.token)))
);
router.post(
  '/invitations/:token/accept',
  asyncHandler(async (req, res) => res.json(await teamService.acceptInvitation(req.params.token, req.body)))
);
// Second sign-in step when SMS codes are on.
router.post('/verify-2fa', adminAuthController.verifyTwoFactor);
router.get('/me', requireAdminAuth, adminAuthController.me);
// Sign out: this device, or every device (the token stops working at once).
const adminSessions = sessionHandlers(Admin, 'admin');
router.post('/logout', requireAdminAuth, adminSessions.logout);
router.post('/logout-all', requireAdminAuth, adminSessions.logoutAll);
router.post('/change-password', requireAdminAuth, adminAuthController.changePassword);

// SMS codes: set up / turn off, and codes that confirm money actions.
router.post('/2fa/start', requireAdminAuth, adminAuthController.startTwoFactor);
router.post('/2fa/enable', requireAdminAuth, adminAuthController.enableTwoFactor);
router.post('/2fa/disable', requireAdminAuth, adminAuthController.disableTwoFactor);
router.post('/action-code', requireAdminAuth, adminAuthController.sendActionCode);

module.exports = router;
