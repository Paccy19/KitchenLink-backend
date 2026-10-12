const { Router } = require('express');
const requireAdminAuth = require('../middleware/requireAdminAuth');
const adminAuthController = require('../controllers/adminAuthController');

const router = Router();

router.post('/login', adminAuthController.login);
// Second sign-in step when SMS codes are on.
router.post('/verify-2fa', adminAuthController.verifyTwoFactor);
router.get('/me', requireAdminAuth, adminAuthController.me);
router.post('/change-password', requireAdminAuth, adminAuthController.changePassword);

// SMS codes: set up / turn off, and codes that confirm money actions.
router.post('/2fa/start', requireAdminAuth, adminAuthController.startTwoFactor);
router.post('/2fa/enable', requireAdminAuth, adminAuthController.enableTwoFactor);
router.post('/2fa/disable', requireAdminAuth, adminAuthController.disableTwoFactor);
router.post('/action-code', requireAdminAuth, adminAuthController.sendActionCode);

module.exports = router;
