const asyncHandler = require('../utils/asyncHandler');
const adminUserService = require('../services/adminUserService');

const list = asyncHandler(async (req, res) => {
  res.json(await adminUserService.list(req.query));
});

const getById = asyncHandler(async (req, res) => {
  res.json(await adminUserService.getById(req.params.userId, req.query));
});

const setStatus = asyncHandler(async (req, res) => {
  res.json(
    await adminUserService.setStatus(
      req.params.userId,
      {
        role: req.body?.role,
        status: req.body?.status,
        reason: req.body?.reason,
      },
      req.admin,
      req
    )
  );
});

module.exports = { list, getById, setStatus };
