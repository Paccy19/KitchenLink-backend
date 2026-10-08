const { Router } = require('express');
const vendorController = require('../controllers/vendorController');

const router = Router();

router.get('/vendors/:vendor_id', vendorController.getVendor);

module.exports = router;
