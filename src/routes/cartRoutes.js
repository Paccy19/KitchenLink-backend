const { Router } = require('express');
const requireAuth = require('../middleware/requireAuth');
const cartController = require('../controllers/cartController');

const router = Router();

router.get('/cart', requireAuth, cartController.getCart);
router.post('/cart', requireAuth, cartController.add);
router.patch('/cart/:menu_item_id', requireAuth, cartController.update);
router.delete('/cart/:menu_item_id', requireAuth, cartController.remove);
router.delete('/cart', requireAuth, cartController.clear);
router.put('/cart', requireAuth, cartController.replace);

module.exports = router;
