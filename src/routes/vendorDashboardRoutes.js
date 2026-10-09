const { Router } = require('express');
const requireVendorAuth = require('../middleware/requireVendorAuth');
const vendorDashboardController = require('../controllers/vendorDashboardController');

const router = Router();

router.get('/dashboard', requireVendorAuth, vendorDashboardController.overview);

module.exports = router;
