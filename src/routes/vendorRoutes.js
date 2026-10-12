const { Router } = require('express');
const vendorController = require('../controllers/vendorController');

const router = Router();

router.get('/vendors/specials', vendorController.getSpecials);
router.get('/vendors/:vendor_id', vendorController.getVendor);
router.get('/vendors/:vendor_id/delivery-quote', vendorController.getDeliveryQuote);

module.exports = router;
