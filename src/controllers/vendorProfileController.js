const asyncHandler = require('../utils/asyncHandler');
const vendorProfileService = require('../services/vendorProfileService');

const update = asyncHandler(async (req, res) => {
  res.json(await vendorProfileService.update(req.vendor, req.body, req.files));
});

const setAvailability = asyncHandler(async (req, res) => {
  res.json(await vendorProfileService.setAvailability(req.vendor, req.body));
});

const requestTypeChange = asyncHandler(async (req, res) => {
  res.json(await vendorProfileService.requestTypeChange(req.vendor, req.body));
});

const getOrdering = asyncHandler(async (req, res) => {
  res.json(await vendorProfileService.getOrdering(req.vendor));
});

const updateOrdering = asyncHandler(async (req, res) => {
  res.json(await vendorProfileService.updateOrdering(req.vendor, req.body));
});

const cancelTypeChange = asyncHandler(async (req, res) => {
  res.json(await vendorProfileService.cancelTypeChange(req.vendor));
});

const getNationwide = asyncHandler(async (req, res) => {
  res.json(vendorProfileService.getNationwide(req.vendor));
});

const updateNationwide = asyncHandler(async (req, res) => {
  res.json(await vendorProfileService.updateNationwide(req.vendor, req.body || {}));
});

module.exports = { update, setAvailability, requestTypeChange, cancelTypeChange, getOrdering, updateOrdering, getNationwide, updateNationwide };
