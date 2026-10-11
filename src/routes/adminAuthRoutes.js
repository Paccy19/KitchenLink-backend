const { Router } = require('express');
const requireAdminAuth = require('../middleware/requireAdminAuth');
const adminAuthController = require('../controllers/adminAuthController');

const router = Router();

router.post('/login', adminAuthController.login);
router.get('/me', requireAdminAuth, adminAuthController.me);
router.post('/change-password', requireAdminAuth, adminAuthController.changePassword);

module.exports = router;
