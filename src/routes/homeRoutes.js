const { Router } = require('express');
const homeController = require('../controllers/homeController');

const router = Router();

router.get('/home/feed', homeController.feed);
router.get('/home/categories', homeController.categories);
router.get('/home/vendors/nearby', homeController.nearbyVendors);
router.get('/home/search', homeController.search);

module.exports = router;
