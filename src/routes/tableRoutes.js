const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const rateLimit = require('../middleware/rateLimit');
const ApiError = require('../utils/ApiError');
const { verifyToken } = require('../utils/jwt');
const { assertSessionActive } = require('../utils/sessions');
const customerRepository = require('../repositories/customerRepository');
const tableOrderService = require('../services/kitchen/tableOrderService');

/**
 * Public: what a table's QR code opens (/menu/<token> on the website).
 * Guests order without an account; a signed-in customer's order is also
 * saved to their account.
 */
const router = Router();

// A customer token is optional here; a broken one is refused (never ignored).
const optionalCustomer = asyncHandler(async (req, res, next) => {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) return next();
  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    throw ApiError.unauthorized('Your session has expired. Sign in again or continue as a guest.', 'TOKEN_EXPIRED');
  }
  if (payload.role) return next(); // a kitchen / driver / admin token: order as a guest
  const customer = await customerRepository.findById(payload.sub);
  if (customer && customer.is_active !== false) {
    await assertSessionActive(payload, customer);
    req.customer = customer;
  }
  return next();
});

const orderLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  code: 'TABLE_ORDER_RATE_LIMITED',
  message: 'Too many orders from this network in a minute. Please wait a moment.',
});
const readLimit = rateLimit({ windowMs: 60 * 1000, max: 120, code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' });

router.get('/:token', readLimit, asyncHandler(async (req, res) => res.json(await tableOrderService.menu(req.params.token))));
router.post(
  '/:token/orders',
  orderLimit,
  optionalCustomer,
  asyncHandler(async (req, res) => res.status(201).json(await tableOrderService.placeOrder(req.params.token, req.body, req.customer || null)))
);
router.get(
  '/:token/orders/:order_id',
  readLimit,
  optionalCustomer,
  asyncHandler(async (req, res) => {
    // A header only: a key in the URL would end up in request logs.
    const key = req.headers['x-guest-key'];
    res.json(await tableOrderService.getOrder(req.params.token, req.params.order_id, key, req.customer || null));
  })
);

// "Call the waiter" / "Bring the bill" from the table (rate limited per network).
const requestLimit = rateLimit({ windowMs: 60 * 1000, max: 6, code: 'TABLE_REQUEST_RATE_LIMITED', message: 'Please wait a moment before asking again.' });
router.post(
  '/:token/requests',
  requestLimit,
  asyncHandler(async (req, res) => res.status(201).json(await tableOrderService.request(req.params.token, req.body)))
);
router.get('/:token/requests', readLimit, asyncHandler(async (req, res) => res.json(await tableOrderService.openRequests(req.params.token))));
// A guest rates their order (the guest key proves it is theirs).
router.post(
  '/:token/orders/:order_id/feedback',
  requestLimit,
  optionalCustomer,
  asyncHandler(async (req, res) => res.status(201).json(await tableOrderService.feedback(req.params.token, req.params.order_id, req.headers['x-guest-key'], req.body, req.customer || null)))
);

module.exports = router;
