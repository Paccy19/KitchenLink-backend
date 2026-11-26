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
router.get('/categories', can(...require('../config/kitchenAccess').inGroup('menu')), vendorMenuController.categories);
router.post('/categories', can('menu.categories'), vendorMenuController.createCategory);
router.patch('/categories/:category_id', can('menu.categories_edit'), asyncHandler(async (req, res) => res.json(await require('../services/vendorMenuService').renameCategory(req.vendor, req.params.category_id, req.body))));
router.delete('/categories/:category_id', can('menu.categories_delete'), asyncHandler(async (req, res) => res.json(await require('../services/vendorMenuService').deleteCategory(req.vendor, req.params.category_id))));
router.post('/upload-image', can('menu.images', 'menu.create'), upload.single('image'), vendorMenuController.uploadImage);
// Photos of the kitchen's own printed menu (shown to customers).
const vendorMenuService = require('../services/vendorMenuService');
router.get('/photos', can('menu.view'), asyncHandler(async (req, res) => res.json(await vendorMenuService.listPhotos(req.vendor))));
router.post(
  '/photos',
  can('menu.images'),
  upload.single('image'),
  asyncHandler(async (req, res) => res.status(201).json(await vendorMenuService.addPhoto(req.vendor, req.body, req.file)))
);
router.patch('/photos/:photo_id', can('menu.images', 'menu.descriptions'), asyncHandler(async (req, res) => res.json(await vendorMenuService.updatePhoto(req.vendor, req.params.photo_id, req.body))));
router.delete('/photos/:photo_id', can('menu.images'), asyncHandler(async (req, res) => res.json(await vendorMenuService.removePhoto(req.vendor, req.params.photo_id))));
// Anyone who works on the menu (prices, photos, availability…) sees it.
router.get('/', can(...require('../config/kitchenAccess').inGroup('menu')), vendorMenuController.list);
router.post('/', can('menu.create'), upload.single('image'), vendorMenuController.create);
router.put('/:item_id', can('menu.edit', 'menu.prices', 'menu.descriptions', 'menu.images', 'menu.variants', 'menu.addons', 'menu.availability', 'menu.activate', 'menu.featured', 'menu.assign_departments'), upload.single('image'), vendorMenuController.update);
router.delete('/:item_id', can('menu.delete'), vendorMenuController.remove);
router.patch('/:item_id/availability', can('menu.availability', 'menu.activate'), vendorMenuController.setAvailability);
// What one portion uses from stock (automatic stock deduction).
router.put(
  '/:item_id/recipe',
  can('menu.edit', 'inventory.ingredients'),
  asyncHandler(async (req, res) => res.json(await inventoryService.setRecipe(req.kitchenAccess, req.params.item_id, req.body)))
);

module.exports = router;
