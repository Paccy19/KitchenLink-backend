const asyncHandler = require('../utils/asyncHandler');
const notificationService = require('../services/notificationService');

const list = asyncHandler(async (req, res) => {
  res.json(await notificationService.listForAdmin(req.query));
});

const markRead = asyncHandler(async (req, res) => {
  res.json(await notificationService.markAdminRead(req.params.notificationId));
});

const markAllRead = asyncHandler(async (req, res) => {
  res.json(await notificationService.markAllAdminRead());
});

module.exports = { list, markRead, markAllRead };
