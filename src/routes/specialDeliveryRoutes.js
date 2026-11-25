const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const requireAuth = require('../middleware/requireAuth');
const requireVendorAuth = require('../middleware/requireVendorAuth');
const requireApprovedVendor = require('../middleware/requireApprovedVendor');
const rateLimit = require('../middleware/rateLimit');
const upload = require('../middleware/upload');
const service = require('../services/specialDeliveryService');
const vendorCoverageService = require('../services/vendorCoverageService');

/**
 * Special delivery negotiation (big events):
 *   /special-deliveries          customers
 *   /vendor/special-deliveries   kitchens
 *   /vendor/delivery-coverage    the kitchen's big-event delivery coverage
 * Admins under /admin/special-deliveries and /admin/settings/big-event-delivery.
 * Status never comes from the client: every route is an action that the
 * transition service checks.
 */
const sendLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  code: 'CHAT_RATE_LIMITED',
  message: 'You are sending messages too fast. Wait a moment and try again.',
});

const ok = (fn, status = 200) =>
  asyncHandler(async (req, res) => {
    res.status(status).json(await fn(req));
  });

/** Chat + dispute routes shared by both sides. */
function chatRoutes(router, side, accountOf) {
  router.get('/:id/messages', ok((req) => service.messages(side, accountOf(req), req.params.id, req.query)));
  router.post('/:id/messages', sendLimit, ok((req) => service.sendMessage(side, accountOf(req), req.params.id, req.body || {}), 201));
  router.post(
    '/:id/attachments',
    sendLimit,
    upload.single('image'),
    ok((req) => service.sendImage(side, accountOf(req), req.params.id, req.file, req.body || {}), 201)
  );
  router.post('/:id/read', ok((req) => service.markRead(side, accountOf(req), req.params.id)));
  router.post('/:id/dispute', ok((req) => service.dispute(side, accountOf(req), req.params.id, req.body || {})));
}

/* -------------------------------- customer -------------------------------- */
const customer = Router();
customer.use(requireAuth);
const me = (req) => req.customer;
customer.get('/', ok((req) => service.listForCustomer(me(req), req.query)));
customer.post('/', ok((req) => service.create(me(req), req.body || {}), 201));
customer.get('/:id', ok((req) => service.getForCustomer(me(req), req.params.id)));
customer.post('/:id/cancel', ok((req) => service.cancel(me(req), req.params.id, req.body || {})));
customer.post('/:id/information', ok((req) => service.provideInformation(me(req), req.params.id, req.body || {})));
customer.post('/:id/quotations/:quotation_id/accept', ok((req) => service.acceptQuotation(me(req), req.params.id, req.params.quotation_id)));
customer.post(
  '/:id/quotations/:quotation_id/request-revision',
  ok((req) => service.requestRevision(me(req), req.params.id, req.params.quotation_id, req.body || {}))
);
customer.post(
  '/:id/quotations/:quotation_id/reject',
  ok((req) => service.rejectQuotation(me(req), req.params.id, req.params.quotation_id, req.body || {}))
);
chatRoutes(customer, 'customer', me);

/* --------------------------------- vendor --------------------------------- */
const vendor = Router();
vendor.use(requireVendorAuth);
const kitchen = (req) => req.vendor;
vendor.get('/', ok((req) => service.listForVendor(kitchen(req), req.query)));
vendor.get('/:id', ok((req) => service.getForVendor(kitchen(req), req.params.id)));
vendor.post('/:id/accept-negotiation', requireApprovedVendor, ok((req) => service.acceptNegotiation(kitchen(req), req.params.id, req.body || {})));
vendor.post('/:id/request-information', requireApprovedVendor, ok((req) => service.requestInformation(kitchen(req), req.params.id, req.body || {})));
vendor.post('/:id/decline', requireApprovedVendor, ok((req) => service.decline(kitchen(req), req.params.id, req.body || {})));
vendor.post('/:id/quotations', requireApprovedVendor, ok((req) => service.submitQuotation(kitchen(req), req.params.id, req.body || {}), 201));
vendor.post(
  '/:id/quotations/:quotation_id/withdraw',
  requireApprovedVendor,
  ok((req) => service.withdrawQuotation(kitchen(req), req.params.id, req.params.quotation_id, req.body || {}))
);
chatRoutes(vendor, 'vendor', kitchen);

/* --------------------------- vendor coverage ----------------------------- */
const coverage = Router();
coverage.use(requireVendorAuth);
coverage.get('/', ok((req) => vendorCoverageService.get(req.vendor)));
coverage.put('/', requireApprovedVendor, ok((req) => vendorCoverageService.update(req.vendor, req.body || {})));
coverage.get('/check', ok((req) => vendorCoverageService.check(req.vendor, req.query)));

module.exports = { customerSpecialDeliveryRoutes: customer, vendorSpecialDeliveryRoutes: vendor, vendorCoverageRoutes: coverage };
