const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const requireAuth = require('../middleware/requireAuth');
const requireVendorAuth = require('../middleware/requireVendorAuth');
const rateLimit = require('../middleware/rateLimit');
const chatService = require('../services/chatService');

/**
 * Customer–kitchen chat: one ongoing conversation per customer and kitchen.
 *   /chats          customers
 *   /vendor/chats   kitchens (vendors)
 * Admins read chats (never write) under /admin/chats.
 */
const sendLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  code: 'CHAT_RATE_LIMITED',
  message: 'You are sending messages too fast. Wait a moment and try again.',
});

const chatRouter = (side, auth, accountKey) => {
  const router = Router();
  const account = (req) => req[accountKey];
  router.use(auth);
  router.get('/', asyncHandler(async (req, res) => res.json(await chatService.list(side, account(req)))));
  router.get('/unread-count', asyncHandler(async (req, res) => res.json(await chatService.unreadCount(side, account(req)))));
  if (side === 'customer') {
    // Opens (or creates) the chat with a kitchen.
    router.post(
      '/with/:vendor_id',
      asyncHandler(async (req, res) => res.json(await chatService.openWithVendor(account(req), req.params.vendor_id)))
    );
  }
  router.get(
    '/:conversation_id',
    asyncHandler(async (req, res) => res.json(await chatService.get(side, account(req), req.params.conversation_id, req.query)))
  );
  router.post(
    '/:conversation_id/messages',
    sendLimit,
    asyncHandler(async (req, res) =>
      res.status(201).json(await chatService.send(side, account(req), req.params.conversation_id, req.body || {}))
    )
  );
  router.post(
    '/:conversation_id/read',
    asyncHandler(async (req, res) => res.json(await chatService.markRead(side, account(req), req.params.conversation_id)))
  );
  return router;
};

module.exports = {
  customerChatRoutes: chatRouter('customer', requireAuth, 'customer'),
  vendorChatRoutes: chatRouter('vendor', requireVendorAuth, 'vendor'),
};
