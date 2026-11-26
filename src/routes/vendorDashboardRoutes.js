const { Router } = require('express');
const requireVendorAuth = require('../middleware/requireVendorAuth');
const requireApprovedVendor = require('../middleware/requireApprovedVendor');
const can = require('../middleware/requireKitchenPermission');

// The kitchen's settings: administrators only (account.settings is never given to a role).
const settings = can('account.settings');
const upload = require('../middleware/upload');
const privateDocumentsService = require('../services/privateDocumentsService');
const vendorDashboardController = require('../controllers/vendorDashboardController');
const vendorProfileController = require('../controllers/vendorProfileController');
const vendorSpecialController = require('../controllers/vendorSpecialController');
const vendorOfferController = require('../controllers/vendorOfferController');

const router = Router();

router.get('/dashboard', requireVendorAuth, can('reports.sales'), vendorDashboardController.overview);
router.get('/special', requireVendorAuth, settings, vendorSpecialController.get);
router.put('/special', requireVendorAuth, settings, requireApprovedVendor, vendorSpecialController.upsert);
router.delete('/special', requireVendorAuth, settings, requireApprovedVendor, vendorSpecialController.clear);
router.get('/offers', requireVendorAuth, settings, vendorOfferController.listMine);
router.post('/offers', requireVendorAuth, settings, requireApprovedVendor, vendorOfferController.create);
router.delete('/offers/:offer_id', requireVendorAuth, settings, requireApprovedVendor, vendorOfferController.cancel);
router.patch(
  '/profile',
  requireVendorAuth,
  settings,
  requireApprovedVendor,
  upload.fields([
    { name: 'banner_image', maxCount: 1 },
    { name: 'profile_image', maxCount: 1 },
  ]),
  vendorProfileController.update
);
router.patch('/availability', requireVendorAuth, settings, requireApprovedVendor, vendorProfileController.setAvailability);
router.get('/ordering', requireVendorAuth, settings, vendorProfileController.getOrdering);
router.put('/ordering', requireVendorAuth, settings, requireApprovedVendor, vendorProfileController.updateOrdering);
// The kitchen's own verification documents (private files).
router.get('/documents/:index', requireVendorAuth, settings, (req, res, next) => {
  try {
    privateDocumentsService.send(res, req.vendor, req.params.index);
  } catch (error) {
    next(error);
  }
});
// Nationwide events: status and the kitchen's own travel fee for far orders.
router.get('/nationwide', requireVendorAuth, settings, vendorProfileController.getNationwide);
router.put('/nationwide', requireVendorAuth, settings, requireApprovedVendor, vendorProfileController.updateNationwide);
// Big events: guest ranges with a plate price, the plate, service and delivery.
router.get('/event-package', requireVendorAuth, settings, vendorProfileController.getEventPackage);
router.put('/event-package', requireVendorAuth, settings, requireApprovedVendor, vendorProfileController.updateEventPackage);
router.post('/profile/type-request', requireVendorAuth, settings, vendorProfileController.requestTypeChange);
router.delete('/profile/type-request', requireVendorAuth, settings, vendorProfileController.cancelTypeChange);

module.exports = router;
