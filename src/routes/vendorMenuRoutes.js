const { Router } = require('express');
const requireVendorAuth = require('../middleware/requireVendorAuth');
const upload = require('../middleware/upload');
const vendorMenuController = require('../controllers/vendorMenuController');
const can = require('../middleware/requireKitchenPermission');
const asyncHandler = require('../utils/asyncHandler');
const inventoryService = require('../services/kitchen/inventoryService');

const router = Router();

// Pending kitchens may build their menu while their documents are reviewed.
// It stays off the marketplace until an admin approves the kitchen (only
// active kitchens and their dishes are listed); rejected or suspended
// kitchens are refused by requireVendorAuth.
router.use(requireVendorAuth);

// Department checks (which dish) happen again in vendorMenuService.
router.get('/categories', can('menu.view'), vendorMenuController.categories);
router.post('/categories', can('menu.categories'), vendorMenuController.createCategory);
router.post('/upload-image', can('menu.create', 'menu.edit'), upload.single('image'), vendorMenuController.uploadImage);
// Photos of the kitchen's own printed menu (shown to customers).
const vendorMenuService = require('../services/vendorMenuService');
router.get('/photos', can('menu.view'), asyncHandler(async (req, res) => res.json(await vendorMenuService.listPhotos(req.vendor))));
router.post(
  '/photos',
  can('menu.create', 'menu.edit'),
  upload.single('image'),
  asyncHandler(async (req, res) => res.status(201).json(await vendorMenuService.addPhoto(req.vendor, req.body, req.file)))
);
router.patch('/photos/:photo_id', can('menu.edit'), asyncHandler(async (req, res) => res.json(await vendorMenuService.updatePhoto(req.vendor, req.params.photo_id, req.body))));
router.delete('/photos/:photo_id', can('menu.delete', 'menu.edit'), asyncHandler(async (req, res) => res.json(await vendorMenuService.removePhoto(req.vendor, req.params.photo_id))));
router.get('/', can('menu.view'), vendorMenuController.list);
router.post('/', can('menu.create'), upload.single('image'), vendorMenuController.create);
router.put('/:item_id', can('menu.edit'), upload.single('image'), vendorMenuController.update);
router.delete('/:item_id', can('menu.delete'), vendorMenuController.remove);
router.patch('/:item_id/availability', can('menu.availability'), vendorMenuController.setAvailability);
// What one portion uses from stock (automatic stock deduction).
router.put(
  '/:item_id/recipe',
  can('menu.edit'),
  asyncHandler(async (req, res) => res.json(await inventoryService.setRecipe(req.kitchenAccess, req.params.item_id, req.body)))
);

module.exports = router;
