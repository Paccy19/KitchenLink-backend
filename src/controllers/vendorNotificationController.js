const asyncHandler = require('../utils/asyncHandler');
const notificationService = require('../services/notificationService');

const list = asyncHandler(async (req, res) => {
  res.json(await notificationService.listForVendor(req.vendor._id, req.query));
});

const markRead = asyncHandler(async (req, res) => {
  res.json(await notificationService.markVendorRead(req.vendor._id, req.params.notification_id));
});

const markAllRead = asyncHandler(async (req, res) => {
  res.json(await notificationService.markAllVendorRead(req.vendor._id));
});

module.exports = { list, markRead, markAllRead };
