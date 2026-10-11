const asyncHandler = require('../utils/asyncHandler');
const adminComplaintService = require('../services/adminComplaintService');

const list = asyncHandler(async (req, res) => {
  res.json(await adminComplaintService.list(req.query));
});

const getById = asyncHandler(async (req, res) => {
  res.json(await adminComplaintService.getById(req.params.complaintId));
});

const create = asyncHandler(async (req, res) => {
  res.status(201).json(await adminComplaintService.create(req.body, req.admin, req));
});

const update = asyncHandler(async (req, res) => {
  res.json(
    await adminComplaintService.update(req.params.complaintId, req.body, req.admin, req)
  );
});

module.exports = { list, getById, create, update };
