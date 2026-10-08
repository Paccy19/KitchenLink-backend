const { Router } = require('express');
const requireAuth = require('../middleware/requireAuth');
const wishlistController = require('../controllers/wishlistController');

const router = Router();

router.get('/wishlist', requireAuth, wishlistController.list);
router.post('/wishlist', requireAuth, wishlistController.add);
router.delete('/wishlist/:menu_item_id', requireAuth, wishlistController.remove);
router.post('/wishlist/:menu_item_id/move-to-cart', requireAuth, wishlistController.moveToCart);

module.exports = router;
