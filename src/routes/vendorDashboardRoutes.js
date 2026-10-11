const { Router } = require('express');
const requireVendorAuth = require('../middleware/requireVendorAuth');
const upload = require('../middleware/upload');
const vendorDashboardController = require('../controllers/vendorDashboardController');
const vendorProfileController = require('../controllers/vendorProfileController');
const vendorSpecialController = require('../controllers/vendorSpecialController');

const router = Router();

router.get('/dashboard', requireVendorAuth, vendorDashboardController.overview);
router.get('/special', requireVendorAuth, vendorSpecialController.get);
router.put('/special', requireVendorAuth, vendorSpecialController.upsert);
router.delete('/special', requireVendorAuth, vendorSpecialController.clear);
router.patch(
  '/profile',
  requireVendorAuth,
  upload.fields([
    { name: 'banner_image', maxCount: 1 },
    { name: 'profile_image', maxCount: 1 },
  ]),
  vendorProfileController.update
);

module.exports = router;
