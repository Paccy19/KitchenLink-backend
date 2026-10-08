const { Router } = require('express');
const requireAuth = require('../middleware/requireAuth');
const wishlistController = require('../controllers/wishlistController');

const router = Router();

router.use(requireAuth);
router.get('/wishlist', wishlistController.list);
router.post('/wishlist', wishlistController.add);
router.delete('/wishlist/:menu_item_id', wishlistController.remove);
router.post('/wishlist/:menu_item_id/move-to-cart', wishlistController.moveToCart);

module.exports = router;
