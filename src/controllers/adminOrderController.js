const asyncHandler = require('../utils/asyncHandler');
const adminOrderService = require('../services/adminOrderService');

const list = asyncHandler(async (req, res) => {
  res.json(await adminOrderService.list(req.query));
});

const getById = asyncHandler(async (req, res) => {
  res.json(await adminOrderService.getById(req.params.orderId));
});

const updateStatus = asyncHandler(async (req, res) => {
  res.json(
    await adminOrderService.updateStatus(
      req.params.orderId,
      { status: req.body?.status, note: req.body?.note },
      req.admin,
      req
    )
  );
});

const cancel = asyncHandler(async (req, res) => {
  res.json(
    await adminOrderService.cancel(
      req.params.orderId,
      { reason: req.body?.reason },
      req.admin,
      req
    )
  );
});

const reassignDriver = asyncHandler(async (req, res) => {
  res.json(
    await adminOrderService.reassignDriver(
      req.params.orderId,
      {
        driver_id: req.body?.driver_id,
        note: req.body?.note,
        reason: req.body?.reason,
        contacted: req.body?.contacted,
      },
      req.admin,
      req
    )
  );
});

module.exports = { list, getById, updateStatus, cancel, reassignDriver };
