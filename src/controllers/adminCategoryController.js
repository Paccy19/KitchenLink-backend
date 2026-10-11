const asyncHandler = require('../utils/asyncHandler');
const adminCategoryService = require('../services/adminCategoryService');

const list = asyncHandler(async (req, res) => {
  res.json(await adminCategoryService.list());
});

const create = asyncHandler(async (req, res) => {
  res.status(201).json(await adminCategoryService.create(req.body, req.admin, req));
});

const update = asyncHandler(async (req, res) => {
  res.json(await adminCategoryService.update(req.params.categoryId, req.body, req.admin, req));
});

const remove = asyncHandler(async (req, res) => {
  res.json(
    await adminCategoryService.remove(
      req.params.categoryId,
      { force: req.query.force === 'true' || req.body?.force === true },
      req.admin,
      req
    )
  );
});

const reorder = asyncHandler(async (req, res) => {
  res.json(await adminCategoryService.reorder(req.body?.items, req.admin, req));
});

module.exports = { list, create, update, remove, reorder };
