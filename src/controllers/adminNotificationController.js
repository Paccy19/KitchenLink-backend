const asyncHandler = require('../utils/asyncHandler');
const notificationService = require('../services/notificationService');

const list = asyncHandler(async (req, res) => {
  res.json(await notificationService.listForAdmin(req.admin, req.query));
});

const markRead = asyncHandler(async (req, res) => {
  res.json(await notificationService.markAdminRead(req.admin, req.params.notificationId));
});

const markAllRead = asyncHandler(async (req, res) => {
  res.json(await notificationService.markAllAdminRead(req.admin));
});

module.exports = { list, markRead, markAllRead };
