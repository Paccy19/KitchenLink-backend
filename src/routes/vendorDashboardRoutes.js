const { Router } = require('express');
const requireVendorAuth = require('../middleware/requireVendorAuth');
const upload = require('../middleware/upload');
const vendorDashboardController = require('../controllers/vendorDashboardController');
const vendorProfileController = require('../controllers/vendorProfileController');

const router = Router();

router.get('/dashboard', requireVendorAuth, vendorDashboardController.overview);
router.patch(
  '/profile',
  requireVendorAuth,
  upload.single('banner_image'),
  vendorProfileController.update
);

module.exports = router;
