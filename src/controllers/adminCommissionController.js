const asyncHandler = require('../utils/asyncHandler');
const adminCommissionService = require('../services/adminCommissionService');

const list = asyncHandler(async (req, res) => {
  res.json(await adminCommissionService.list(req.query));
});

const create = asyncHandler(async (req, res) => {
  res
    .status(201)
    .json(await adminCommissionService.create(req.body, req.admin, req));
});

const update = asyncHandler(async (req, res) => {
  res.json(
    await adminCommissionService.update(req.params.commissionId, req.body, req.admin, req)
  );
});

const remove = asyncHandler(async (req, res) => {
  res.json(await adminCommissionService.remove(req.params.commissionId, req.admin, req));
});

module.exports = { list, create, update, remove };
