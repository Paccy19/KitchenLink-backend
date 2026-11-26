const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const rateLimit = require('../middleware/rateLimit');
const ApiError = require('../utils/ApiError');
const { verifyToken } = require('../utils/jwt');
const { assertSessionActive } = require('../utils/sessions');
const customerRepository = require('../repositories/customerRepository');
const tableOrderService = require('../services/kitchen/tableOrderService');
const tablePaymentService = require('../services/kitchen/tablePaymentService');

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
const sessionLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  code: 'DINING_SESSION_RATE_LIMITED',
  message: 'Too many seat sessions were started from this network. Please wait a moment.',
});
const paymentLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  code: 'TABLE_PAYMENT_RATE_LIMITED',
  message: 'Too many payment attempts. Please wait a moment before trying again.',
});
const readLimit = rateLimit({ windowMs: 60 * 1000, max: 120, code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' });

router.get('/:token', readLimit, asyncHandler(async (req, res) => res.json(await tableOrderService.menu(req.params.token))));
router.post(
  '/:token/session',
  sessionLimit,
  optionalCustomer,
  asyncHandler(async (req, res) => {
    const key = req.headers['x-dining-session-key'];
    res.status(201).json(await tableOrderService.openSession(req.params.token, req.body, req.customer || null, key));
  })
);
router.post(
  '/:token/orders',
  orderLimit,
  optionalCustomer,
  asyncHandler(async (req, res) => {
    const key = req.headers['x-dining-session-key'];
    res.status(201).json(await tableOrderService.placeOrder(req.params.token, req.body, req.customer || null, key));
  })
);
router.get(
  '/:token/payment-seats',
  readLimit,
  optionalCustomer,
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.json(await tablePaymentService.payableSeats(
      req.params.token,
      req.customer || null,
      req.headers['x-dining-session-key']
    ));
  })
);
router.post(
  '/:token/payment-authorizations',
  paymentLimit,
  optionalCustomer,
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.status(201).json(await tablePaymentService.createAuthorization(
      req.params.token,
      req.customer || null,
      req.headers['x-dining-session-key']
    ));
  })
);
router.post(
  '/:token/payment-authorizations/join',
  paymentLimit,
  optionalCustomer,
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.json(await tablePaymentService.acceptAuthorization(
      req.params.token,
      req.customer || null,
      req.headers['x-dining-session-key'],
      req.body?.code
    ));
  })
);
router.delete(
  '/:token/payment-authorizations/:authorization_id',
  paymentLimit,
  optionalCustomer,
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.json(await tablePaymentService.revokeAuthorization(
      req.params.token,
      req.customer || null,
      req.headers['x-dining-session-key'],
      req.params.authorization_id
    ));
  })
);
router.post(
  '/:token/payments',
  paymentLimit,
  optionalCustomer,
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.status(201).json(await tablePaymentService.initiatePayment(
      req.params.token,
      req.customer || null,
      req.headers['x-dining-session-key'],
      req.body
    ));
  })
);
router.post(
  '/:token/payments/:payment_id/check',
  readLimit,
  optionalCustomer,
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.json(await tablePaymentService.checkPayment(
      req.params.token,
      req.customer || null,
      req.headers['x-dining-session-key'],
      req.params.payment_id
    ));
  })
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
module.exports.optionalCustomer = optionalCustomer;
