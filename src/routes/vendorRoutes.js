const { Router } = require('express');
const config = require('../config');
const rateLimit = require('../middleware/rateLimit');
const vendorController = require('../controllers/vendorController');
const vendorOfferController = require('../controllers/vendorOfferController');

const router = Router();

router.get('/vendors', vendorController.listVendors);
router.get('/vendors/types', vendorController.getTypes);
router.get('/vendors/specials', vendorController.getSpecials);
router.get('/vendors/offers', vendorOfferController.listUpcoming);
router.get('/vendors/:vendor_id', vendorController.getVendor);
// Public and may call the paid Google Routes API: limited per IP.
const quoteLimit = rateLimit({
  windowMs: 60 * 1000,
  max: config.rateLimits.deliveryQuotePerMinute,
  code: 'QUOTE_RATE_LIMITED',
  message: 'Too many delivery price checks. Please wait a moment and try again.',
});
router.get('/vendors/:vendor_id/delivery-quote', quoteLimit, vendorController.getDeliveryQuote);

module.exports = router;
