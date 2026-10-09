const { Router } = require('express');
const requireVendorAuth = require('../middleware/requireVendorAuth');
const upload = require('../middleware/upload');
const vendorMenuController = require('../controllers/vendorMenuController');

const router = Router();

router.use(requireVendorAuth);

router.get('/categories', vendorMenuController.categories);
router.post('/upload-image', upload.single('image'), vendorMenuController.uploadImage);
router.get('/', vendorMenuController.list);
router.post('/', upload.single('image'), vendorMenuController.create);
router.put('/:item_id', upload.single('image'), vendorMenuController.update);
router.delete('/:item_id', vendorMenuController.remove);
router.patch('/:item_id/availability', vendorMenuController.setAvailability);

module.exports = router;
