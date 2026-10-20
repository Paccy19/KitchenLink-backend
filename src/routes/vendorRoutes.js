const { Router } = require('express');
const vendorController = require('../controllers/vendorController');
const vendorOfferController = require('../controllers/vendorOfferController');

const router = Router();

router.get('/vendors/specials', vendorController.getSpecials);
router.get('/vendors/offers', vendorOfferController.listUpcoming);
router.get('/vendors/:vendor_id', vendorController.getVendor);
router.get('/vendors/:vendor_id/delivery-quote', vendorController.getDeliveryQuote);

module.exports = router;
