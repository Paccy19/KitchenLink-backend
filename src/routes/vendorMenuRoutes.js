const { Router } = require('express');
const requireVendorAuth = require('../middleware/requireVendorAuth');
const requireApprovedVendor = require('../middleware/requireApprovedVendor');
const upload = require('../middleware/upload');
const vendorMenuController = require('../controllers/vendorMenuController');

const router = Router();

router.use(requireVendorAuth);

router.get('/categories', vendorMenuController.categories);
router.post('/upload-image', requireApprovedVendor, upload.single('image'), vendorMenuController.uploadImage);
router.get('/', vendorMenuController.list);
router.post('/', requireApprovedVendor, upload.single('image'), vendorMenuController.create);
router.put('/:item_id', requireApprovedVendor, upload.single('image'), vendorMenuController.update);
router.delete('/:item_id', requireApprovedVendor, vendorMenuController.remove);
router.patch('/:item_id/availability', requireApprovedVendor, vendorMenuController.setAvailability);

module.exports = router;
