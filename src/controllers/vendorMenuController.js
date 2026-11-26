const asyncHandler = require('../utils/asyncHandler');
const vendorMenuService = require('../services/vendorMenuService');

const createCategory = asyncHandler(async (req, res) => {
  const result = await vendorMenuService.createCategory(req.vendor, req.body);
  res.status(result.created ? 201 : 200).json(result);
});

const categories = asyncHandler(async (req, res) => {
  res.json(await vendorMenuService.categories());
});

const list = asyncHandler(async (req, res) => {
  res.json(await vendorMenuService.list(req.vendor, req.query, req.kitchenAccess));
});

const create = asyncHandler(async (req, res) => {
  res.status(201).json(await vendorMenuService.create(req.vendor, req.body, req.file, req.kitchenAccess));
});

const update = asyncHandler(async (req, res) => {
  res.json(
    await vendorMenuService.update(req.vendor, req.params.item_id, req.body, req.file, req.kitchenAccess)
  );
});

const remove = asyncHandler(async (req, res) => {
  res.json(await vendorMenuService.remove(req.vendor, req.params.item_id, req.query, req.kitchenAccess));
});

const setAvailability = asyncHandler(async (req, res) => {
  res.json(
    await vendorMenuService.setAvailability(
      req.vendor,
      req.params.item_id,
      req.body,
      req.kitchenAccess
    )
  );
});

const uploadImage = asyncHandler(async (req, res) => {
  res.status(201).json(vendorMenuService.uploadImage(req.file));
});

module.exports = {
  categories,
  createCategory,
  list,
  create,
  update,
  remove,
  setAvailability,
  uploadImage,
};
