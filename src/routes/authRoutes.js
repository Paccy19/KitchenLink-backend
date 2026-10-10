const { Router } = require('express');
const authController = require('../controllers/authController');
const requireAuth = require('../middleware/requireAuth');
const upload = require('../middleware/upload');

const router = Router();

router.post('/auth/send-otp', authController.sendOtp);
router.post('/auth/verify-otp', authController.verifyOtp);
router.get('/auth/me', requireAuth, authController.me);
router.patch(
  '/auth/me/profile',
  requireAuth,
  upload.single('profile_image'),
  authController.updateProfile
);

module.exports = router;
