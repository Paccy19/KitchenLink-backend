const asyncHandler = require('../utils/asyncHandler');
const notificationService = require('../services/notificationService');

const listNotifications = asyncHandler(async (req, res) => {
  res.json(await notificationService.list(req.customer._id, req.query));
});

const markNotificationRead = asyncHandler(async (req, res) => {
  res.json(await notificationService.markRead(req.customer._id, req.params.notification_id));
});

const markAllNotificationsRead = asyncHandler(async (req, res) => {
  res.json(await notificationService.markAllRead(req.customer._id));
});

module.exports = {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
};
