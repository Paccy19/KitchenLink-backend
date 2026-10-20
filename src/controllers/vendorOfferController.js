const asyncHandler = require('../utils/asyncHandler');
const { parseOptionalCoords } = require('../utils/geo');
const vendorOfferService = require('../services/vendorOfferService');

const listMine = asyncHandler(async (req, res) => {
  res.json(await vendorOfferService.listForVendor(req.vendor));
});

const create = asyncHandler(async (req, res) => {
  res.status(201).json(await vendorOfferService.create(req.vendor, req.body));
});

const cancel = asyncHandler(async (req, res) => {
  res.json(await vendorOfferService.cancel(req.vendor, req.params.offer_id));
});

/** Public: upcoming offer days from every kitchen. */
const listUpcoming = asyncHandler(async (req, res) => {
  res.json(await vendorOfferService.listUpcoming(parseOptionalCoords(req.query)));
});

module.exports = { listMine, create, cancel, listUpcoming };
