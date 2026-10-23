const { Router } = require('express');
const requireVendorAuth = require('../middleware/requireVendorAuth');
const requireApprovedVendor = require('../middleware/requireApprovedVendor');
const upload = require('../middleware/upload');
const vendorDashboardController = require('../controllers/vendorDashboardController');
const vendorProfileController = require('../controllers/vendorProfileController');
const vendorSpecialController = require('../controllers/vendorSpecialController');
const vendorOfferController = require('../controllers/vendorOfferController');

const router = Router();

router.get('/dashboard', requireVendorAuth, vendorDashboardController.overview);
router.get('/special', requireVendorAuth, vendorSpecialController.get);
router.put('/special', requireVendorAuth, requireApprovedVendor, vendorSpecialController.upsert);
router.delete('/special', requireVendorAuth, requireApprovedVendor, vendorSpecialController.clear);
router.get('/offers', requireVendorAuth, vendorOfferController.listMine);
router.post('/offers', requireVendorAuth, requireApprovedVendor, vendorOfferController.create);
router.delete('/offers/:offer_id', requireVendorAuth, requireApprovedVendor, vendorOfferController.cancel);
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
router.get('/ordering', requireVendorAuth, vendorProfileController.getOrdering);
router.put('/ordering', requireVendorAuth, requireApprovedVendor, vendorProfileController.updateOrdering);
router.post('/profile/type-request', requireVendorAuth, vendorProfileController.requestTypeChange);
router.delete('/profile/type-request', requireVendorAuth, vendorProfileController.cancelTypeChange);

module.exports = router;
