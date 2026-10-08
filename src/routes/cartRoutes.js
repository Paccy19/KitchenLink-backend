const { Router } = require('express');
const requireAuth = require('../middleware/requireAuth');
const cartController = require('../controllers/cartController');

const router = Router();

router.use(requireAuth);
router.get('/cart', cartController.getCart);
router.post('/cart', cartController.add);
router.patch('/cart/:menu_item_id', cartController.update);
router.delete('/cart/:menu_item_id', cartController.remove);
router.delete('/cart', cartController.clear);

module.exports = router;
