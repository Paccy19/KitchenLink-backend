const { Router } = require('express');
const requireVendorAuth = require('../middleware/requireVendorAuth');
const requireApprovedVendor = require('../middleware/requireApprovedVendor');
const can = require('../middleware/requireKitchenPermission');

const settingsFields = require('../middleware/kitchenSettingsFields');
const upload = require('../middleware/upload');
const privateDocumentsService = require('../services/privateDocumentsService');
const vendorDashboardController = require('../controllers/vendorDashboardController');
const vendorProfileController = require('../controllers/vendorProfileController');
const vendorSpecialController = require('../controllers/vendorSpecialController');
const vendorOfferController = require('../controllers/vendorOfferController');

const router = Router();

router.get('/dashboard', requireVendorAuth, can('overview.dashboard'), require('../middleware/kitchenDashboardFilter'), vendorDashboardController.overview);
// Tomorrow's Special and Offer Days are the kitchen's promotions.
router.get('/special', requireVendorAuth, can('promotions.view', 'promotions.create', 'promotions.edit'), vendorSpecialController.get);
router.put('/special', requireVendorAuth, can('promotions.create', 'promotions.edit'), requireApprovedVendor, vendorSpecialController.upsert);
router.delete('/special', requireVendorAuth, can('promotions.delete'), requireApprovedVendor, vendorSpecialController.clear);
router.get('/offers', requireVendorAuth, can('promotions.view', 'promotions.create'), vendorOfferController.listMine);
router.post('/offers', requireVendorAuth, can('promotions.create'), requireApprovedVendor, vendorOfferController.create);
router.delete('/offers/:offer_id', requireVendorAuth, can('promotions.delete'), requireApprovedVendor, vendorOfferController.cancel);
router.patch(
  '/profile',
  requireVendorAuth,
  can('settings.edit_profile', 'settings.images', 'settings.contact', 'settings.hours', 'settings.payment_preferences'),
  requireApprovedVendor,
  upload.fields([
    { name: 'banner_image', maxCount: 1 },
    { name: 'profile_image', maxCount: 1 },
  ]),
  settingsFields,
  vendorProfileController.update
);
router.patch('/availability', requireVendorAuth, can('settings.availability'), requireApprovedVendor, vendorProfileController.setAvailability);
router.get('/ordering', requireVendorAuth, can('settings.view_profile', 'settings.order_acceptance'), vendorProfileController.getOrdering);
router.put('/ordering', requireVendorAuth, can('settings.order_acceptance'), requireApprovedVendor, vendorProfileController.updateOrdering);
// The kitchen's own verification documents (private files).
router.get('/documents/:index', requireVendorAuth, can.admin, (req, res, next) => {
  try {
    privateDocumentsService.send(res, req.vendor, req.params.index);
  } catch (error) {
    next(error);
  }
});
// Nationwide events: status and the kitchen's own travel fee for far orders.
router.get('/nationwide', requireVendorAuth, can('delivery.fees', 'delivery.settings'), vendorProfileController.getNationwide);
router.put('/nationwide', requireVendorAuth, can('delivery.fees'), requireApprovedVendor, vendorProfileController.updateNationwide);
// Big events: guest ranges with a plate price, the plate, service and delivery.
router.get('/event-package', requireVendorAuth, can('settings.kitchen_settings', 'settings.view_profile'), vendorProfileController.getEventPackage);
router.put('/event-package', requireVendorAuth, can('settings.kitchen_settings'), requireApprovedVendor, vendorProfileController.updateEventPackage);
router.post('/profile/type-request', requireVendorAuth, can('settings.kitchen_settings'), vendorProfileController.requestTypeChange);
router.delete('/profile/type-request', requireVendorAuth, can('settings.kitchen_settings'), vendorProfileController.cancelTypeChange);

module.exports = router;
