const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const requireAuth = require('../middleware/requireAuth');
const requireVendorAuth = require('../middleware/requireVendorAuth');
const requireDriverAuth = require('../middleware/requireDriverAuth');
const supportService = require('../services/supportService');

/**
 * Support conversations with the admin support team. The same endpoints are
 * mounted for each kind of user:
 *   /support          customers
 *   /vendor/support   vendors
 *   /driver/support   delivery workers
 */
const supportRouter = (role, auth, accountKey) => {
  const router = Router();
  const account = (req) => req[accountKey];
  router.use(auth);
  router.get('/', asyncHandler(async (req, res) => res.json(await supportService.list(role, account(req)))));
  router.get('/unread-count', asyncHandler(async (req, res) => res.json(await supportService.unreadCount(role, account(req)))));
  router.post('/', asyncHandler(async (req, res) => res.status(201).json(await supportService.create(role, account(req), req.body))));
  router.get('/:ticket_id', asyncHandler(async (req, res) => res.json(await supportService.get(role, account(req), req.params.ticket_id))));
  router.post(
    '/:ticket_id/messages',
    asyncHandler(async (req, res) => res.json(await supportService.reply(role, account(req), req.params.ticket_id, req.body)))
  );
  return router;
};

module.exports = {
  customerSupportRoutes: supportRouter('customer', requireAuth, 'customer'),
  vendorSupportRoutes: supportRouter('vendor', requireVendorAuth, 'vendor'),
  driverSupportRoutes: supportRouter('driver', requireDriverAuth, 'driver'),
};
