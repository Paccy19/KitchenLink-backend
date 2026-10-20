const { Router } = require('express');
const requireVendorAuth = require('../middleware/requireVendorAuth');
const requireApprovedVendor = require('../middleware/requireApprovedVendor');
const upload = require('../middleware/upload');
const vendorDashboardController = require('../controllers/vendorDashboardController');
const vendorProfileController = require('../controllers/vendorProfileController');
const vendorSpecialController = require('../controllers/vendorSpecialController');

const router = Router();

router.get('/dashboard', requireVendorAuth, vendorDashboardController.overview);
router.get('/special', requireVendorAuth, vendorSpecialController.get);
router.put('/special', requireVendorAuth, requireApprovedVendor, vendorSpecialController.upsert);
router.delete('/special', requireVendorAuth, requireApprovedVendor, vendorSpecialController.clear);
router.patch(
  '/profile',
  requireVendorAuth,
  requireApprovedVendor,
  upload.fields([
    { name: 'banner_image', maxCount: 1 },
    { name: 'profile_image', maxCount: 1 },
  ]),
  vendorProfileController.update
);
router.patch('/availability', requireVendorAuth, requireApprovedVendor, vendorProfileController.setAvailability);

module.exports = router;
