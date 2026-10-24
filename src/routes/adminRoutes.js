const { Router } = require('express');
const requireAdminAuth = require('../middleware/requireAdminAuth');
const adminRateLimit = require('../middleware/adminRateLimit');
const requirePermission = require('../middleware/requirePermission');
const requireSuperAdmin = require('../middleware/requireSuperAdmin');
const requirePasswordChanged = require('../middleware/requirePasswordChanged');
const refundService = require('../services/refundService');
const teamService = require('../services/teamService');

const adminUserController = require('../controllers/adminUserController');
const adminVendorController = require('../controllers/adminVendorController');
const adminDriverController = require('../controllers/adminDriverController');
const adminOrderController = require('../controllers/adminOrderController');
const adminPaymentController = require('../controllers/adminPaymentController');
const adminCommissionController = require('../controllers/adminCommissionController');
const adminPayoutController = require('../controllers/adminPayoutController');
const adminPlatformController = require('../controllers/adminPlatformController');
const adminCategoryController = require('../controllers/adminCategoryController');
const adminComplaintController = require('../controllers/adminComplaintController');
const adminDashboardController = require('../controllers/adminDashboardController');
const adminAnalyticsController = require('../controllers/adminAnalyticsController');
const adminNotificationController = require('../controllers/adminNotificationController');
const adminActionLogService = require('../services/adminActionLogService');
const adminOperationsService = require('../services/adminOperationsService');
const deliverySettingsService = require('../services/deliverySettingsService');
const dispatchSettingsService = require('../services/dispatchSettingsService');
const deliveryService = require('../services/deliveryService');
const privateDocumentsService = require('../services/privateDocumentsService');
const vendorRepository = require('../repositories/vendorRepository');
const ApiError = require('../utils/ApiError');

const asyncHandler = require('../utils/asyncHandler');
const chatService = require('../services/chatService');
const bankSettingsService = require('../services/bankSettingsService');
const deliveryFeeSettingsService = require('../services/deliveryFeeSettingsService');

const router = Router();

router.use(requireAdminAuth);
// Still on the seeded password: nothing but changing it (under /admin/auth).
router.use(requirePasswordChanged);
router.use(adminRateLimit);

/* ------------------------------- dashboard ------------------------------- */
router.get('/dashboard/overview', requirePermission('dashboard:read'), adminDashboardController.overview);

/* ----------------------------- notifications ----------------------------- */
router.get('/notifications', adminNotificationController.list);
router.post('/notifications/read-all', adminNotificationController.markAllRead);
router.post('/notifications/:notificationId/read', adminNotificationController.markRead);

/* --------------------------------- users --------------------------------- */
router.get('/users', requirePermission('users:read'), adminUserController.list);
router.get('/users/:userId', requirePermission('users:read'), adminUserController.getById);
router.patch(
  '/users/:userId/status',
  requirePermission('users:write'),
  adminUserController.setStatus
);

/* -------------------------------- vendors -------------------------------- */
router.get('/vendors', requirePermission('vendors:read'), adminVendorController.list);
router.get('/vendors/counts', requirePermission('vendors:read'), adminVendorController.counts);
router.get('/vendors/:vendorId', requirePermission('vendors:read'), adminVendorController.getById);
// A verification document (private file): only admins who can see vendors.
router.get(
  '/vendors/:vendorId/documents/:index',
  requirePermission('vendors:read'),
  asyncHandler(async (req, res) => {
    const vendor = await vendorRepository.findById(req.params.vendorId).catch(() => null);
    if (!vendor) throw ApiError.notFound('Vendor not found.', 'VENDOR_NOT_FOUND');
    return privateDocumentsService.send(res, vendor, req.params.index);
  })
);
router.post(
  '/vendors/:vendorId/documents/review',
  requirePermission('vendors:write'),
  adminVendorController.reviewDocuments
);
router.patch(
  '/vendors/:vendorId/type',
  requirePermission('vendors:write'),
  adminVendorController.setType
);
router.patch(
  '/vendors/:vendorId/nationwide',
  requirePermission('vendors:write'),
  adminVendorController.setNationwide
);
router.patch(
  '/vendors/:vendorId/status',
  requirePermission('vendors:write'),
  adminVendorController.setStatus
);

/* -------------------------------- drivers -------------------------------- */
router.get('/drivers', requirePermission('drivers:read'), adminDriverController.list);
router.get('/drivers/counts', requirePermission('drivers:read'), adminDriverController.counts);
router.get('/drivers/:driverId', requirePermission('drivers:read'), adminDriverController.getById);
router.patch(
  '/drivers/:driverId/status',
  requirePermission('drivers:write'),
  adminDriverController.setStatus
);

/* ------------------------------ deliveries ------------------------------- */
router.get(
  '/deliveries/live',
  requirePermission('deliveries:read'),
  adminDriverController.liveDeliveries
);
// One delivery's rider position, route and ETA (order details map).
router.get(
  '/deliveries/:deliveryId/live',
  requirePermission('deliveries:read'),
  asyncHandler(async (req, res) => res.json(await adminOperationsService.deliveryLive(req.params.deliveryId)))
);

/* ------------------------------- operations ------------------------------ */
// Live operations map: deliveries in progress, online workers, open kitchens.
router.get(
  '/operations/live-map',
  requirePermission('deliveries:read'),
  asyncHandler(async (req, res) => res.json(await adminOperationsService.liveMap()))
);
// Pickups collected (or still waiting) after the grace period, with charge status.
router.get(
  '/operations/late-pickups',
  requirePermission('deliveries:read'),
  asyncHandler(async (req, res) => res.json(await adminOperationsService.latePickups(req.query)))
);
// Delivery fee by distance ranges (no fee below 500 RWF).
router.get(
  '/settings/delivery-fees',
  requirePermission('deliveries:read'),
  asyncHandler(async (req, res) => res.json(deliveryFeeSettingsService.current()))
);
router.put(
  '/settings/delivery-fees',
  requirePermission('deliveries:write'),
  asyncHandler(async (req, res) => {
    const { previous, current } = await deliveryFeeSettingsService.update(req.admin, req.body);
    const describe = (ranges) =>
      ranges.length
        ? ranges.map((r) => `${r.from_km}-${r.to_km ?? '∞'} km: ${r.fee_rwf} RWF`)
        : ['standard formula'];
    await adminActionLogService.record(
      req.admin,
      {
        action: 'settings.delivery_fees',
        target_type: 'system',
        target_id: 'delivery_fees',
        target_label: 'Delivery fee by distance',
        metadata: { before: describe(previous.ranges), after: describe(current.ranges) },
      },
      req
    );
    res.json(current);
  })
);

// Banks people can withdraw to, with each bank's account-number length.
router.get(
  '/settings/banks',
  requirePermission('payouts:read'),
  asyncHandler(async (req, res) => res.json(bankSettingsService.list()))
);
router.put(
  '/settings/banks',
  requirePermission('payouts:write'),
  asyncHandler(async (req, res) => {
    const { previous, current } = await bankSettingsService.update(req.admin, req.body);
    await adminActionLogService.record(
      req.admin,
      {
        action: 'settings.banks',
        target_type: 'system',
        target_id: 'banks',
        target_label: 'Bank account number lengths',
        metadata: {
          before: previous.banks.map((bank) => `${bank.name}: ${bank.digits_min ?? '?'}-${bank.digits_max ?? '?'}`),
          after: current.banks.map((bank) => `${bank.name}: ${bank.digits_min ?? '?'}-${bank.digits_max ?? '?'}`),
        },
      },
      req
    );
    res.json(current);
  })
);

// Delivery timing rules: warning, late charge and automatic reassignment.
router.get(
  '/operations/delivery-timing',
  requirePermission('deliveries:read'),
  asyncHandler(async (req, res) => res.json({ timing: deliverySettingsService.current() }))
);
router.put(
  '/operations/delivery-timing',
  requirePermission('deliveries:write'),
  asyncHandler(async (req, res) => {
    const { previous, current } = await deliverySettingsService.update(req.admin, req.body);
    await adminActionLogService.record(
      req.admin,
      {
        action: 'settings.delivery_timing',
        target_type: 'system',
        target_id: 'delivery_timing',
        target_label: 'Delivery timing rules',
        metadata: {
          before: {
            warning: previous.warning_minutes,
            charge: previous.charge_after_minutes,
            reassign: previous.reassign_after_minutes,
          },
          after: {
            warning: current.warning_minutes,
            charge: current.charge_after_minutes,
            reassign: current.reassign_after_minutes,
          },
        },
      },
      req
    );
    res.json({ timing: current });
  })
);
// The dispatch, pickup, tracking and SMS rules currently in force.
router.get(
  '/operations/rules',
  requirePermission('dashboard:read'),
  asyncHandler(async (req, res) => res.json(adminOperationsService.rules()))
);
// Dispatch and customer-pickup rules: who is notified of new orders, how often
// they are re-offered, deliveries per worker and wrong pickup codes allowed.
router.put(
  '/operations/rules',
  requirePermission('deliveries:write'),
  asyncHandler(async (req, res) => {
    const { previous, current } = await dispatchSettingsService.update(req.admin, req.body);
    // The re-offer interval is a timer: restart it so the new value applies now.
    if (previous.rebroadcast_every_seconds !== current.rebroadcast_every_seconds) deliveryService.start();
    const pick = (rules) => Object.fromEntries(dispatchSettingsService.FIELDS.map((field) => [field, rules[field]]));
    await adminActionLogService.record(
      req.admin,
      {
        action: 'settings.dispatch_rules',
        target_type: 'system',
        target_id: 'dispatch_rules',
        target_label: 'Delivery & pickup rules',
        metadata: { before: pick(previous), after: pick(current) },
      },
      req
    );
    res.json(adminOperationsService.rules());
  })
);

/* --------------------------------- orders -------------------------------- */
router.get('/orders', requirePermission('orders:read'), adminOrderController.list);
router.get('/orders/:orderId', requirePermission('orders:read'), adminOrderController.getById);
router.patch(
  '/orders/:orderId/status',
  requirePermission('orders:write'),
  adminOrderController.updateStatus
);
router.post(
  '/orders/:orderId/cancel',
  requirePermission('orders:write'),
  adminOrderController.cancel
);
// Delivery workers near the kitchen, for support to call before reassigning.
router.get(
  '/orders/:orderId/nearby-drivers',
  requirePermission('orders:write'),
  asyncHandler(async (req, res) => res.json(await adminOperationsService.nearbyDrivers(req.params.orderId, req.query)))
);
router.post(
  '/orders/:orderId/reassign-driver',
  requirePermission('orders:write'),
  adminOrderController.reassignDriver
);

/* -------------------------------- payments ------------------------------- */
router.get('/payments', requirePermission('payments:read'), adminPaymentController.list);
router.get('/payments/summary', requirePermission('payments:read'), adminPaymentController.summary);

/* ------------------------------ commissions ------------------------------ */
router.get('/commissions', requirePermission('commissions:read'), adminCommissionController.list);
router.post('/commissions', requirePermission('commissions:write'), adminCommissionController.create);
router.put(
  '/commissions/:commissionId',
  requirePermission('commissions:write'),
  adminCommissionController.update
);
router.delete(
  '/commissions/:commissionId',
  requirePermission('commissions:write'),
  adminCommissionController.remove
);

/* -------------------------------- payouts -------------------------------- */
router.get('/payouts', requirePermission('payouts:read'), adminPayoutController.list);
router.get('/payouts/balances', requirePermission('payouts:read'), adminPayoutController.balances);
router.get('/payouts/summary', requirePermission('payouts:read'), adminPayoutController.summary);
router.patch(
  '/payouts/:withdrawalId',
  requirePermission('payouts:write'),
  adminPayoutController.update
);

/* -------------------------------- refunds -------------------------------- */
router.get(
  '/refunds',
  requirePermission('refunds:read'),
  asyncHandler(async (req, res) => {
    res.json(await refundService.adminList(req.query));
  })
);
router.patch(
  '/refunds/:refundId',
  requirePermission('refunds:write'),
  asyncHandler(async (req, res) => {
    res.json(await refundService.adminUpdate(req.params.refundId, req.body, req.admin, req));
  })
);

/* --------------------------- platform wallet ----------------------------- */
router.get('/platform/wallet', requirePermission('wallet:read'), adminPlatformController.wallet);
router.get(
  '/platform/transactions',
  requirePermission('wallet:read'),
  adminPlatformController.transactions
);

/* ------------------- owner's money (super admin only) ------------------- */
router.get('/platform/owner', requireSuperAdmin, adminPlatformController.ownerOverview);
router.post('/platform/owner/withdrawals', requireSuperAdmin, adminPlatformController.requestWithdrawal);
router.post(
  '/platform/owner/withdrawals/:withdrawalId/complete',
  requireSuperAdmin,
  adminPlatformController.completeWithdrawal
);
router.post(
  '/platform/owner/withdrawals/:withdrawalId/cancel',
  requireSuperAdmin,
  adminPlatformController.cancelWithdrawal
);
router.post('/platform/owner/destinations', requireSuperAdmin, adminPlatformController.addDestination);
router.post(
  '/platform/owner/destinations/:destinationId/remove',
  requireSuperAdmin,
  adminPlatformController.removeDestination
);
router.post('/platform/owner/adjustments', requireSuperAdmin, adminPlatformController.recordAdjustment);
router.put('/platform/owner/payout-settings', requireSuperAdmin, adminPlatformController.savePayoutSettings);
router.post('/platform/owner/reconciliations', requireSuperAdmin, adminPlatformController.recordReconciliation);

/* ------------------------------ categories ------------------------------- */
router.get('/categories', requirePermission('categories:read'), adminCategoryController.list);
router.post('/categories', requirePermission('categories:write'), adminCategoryController.create);
router.patch(
  '/categories/reorder',
  requirePermission('categories:write'),
  adminCategoryController.reorder
);
router.put(
  '/categories/:categoryId',
  requirePermission('categories:write'),
  adminCategoryController.update
);
router.delete(
  '/categories/:categoryId',
  requirePermission('categories:write'),
  adminCategoryController.remove
);

/* ------------------------------ complaints ------------------------------- */
/* ------------------------- customer–kitchen chats ------------------------ */
// Read only: support can look at a chat but never write in it.
router.get('/chats', requirePermission('chats:read'), asyncHandler(async (req, res) => res.json(await chatService.adminList(req.query))));
router.get(
  '/chats/:conversationId',
  requirePermission('chats:read'),
  asyncHandler(async (req, res) => res.json(await chatService.adminGet(req.params.conversationId, req.query)))
);

router.get('/complaints', requirePermission('complaints:read'), adminComplaintController.list);
router.get(
  '/complaints/:complaintId',
  requirePermission('complaints:read'),
  adminComplaintController.getById
);
router.post('/complaints', requirePermission('complaints:write'), adminComplaintController.create);
router.patch(
  '/complaints/:complaintId',
  requirePermission('complaints:write'),
  adminComplaintController.update
);

/* ------------------------------- analytics ------------------------------- */
router.get('/analytics/overview', requirePermission('analytics:read'), adminAnalyticsController.overview);
router.get('/analytics/sales', requirePermission('analytics:read'), adminAnalyticsController.sales);
router.get('/analytics/payouts', requirePermission('analytics:read'), adminAnalyticsController.payouts);

/* --------------------------- team (owner only) --------------------------- */
const team = requirePermission('team:manage');
router.get('/team', team, asyncHandler(async (req, res) => res.json(await teamService.list())));
router.post(
  '/team/invitations',
  team,
  asyncHandler(async (req, res) => res.status(201).json(await teamService.invite(req.admin, req.body, req)))
);
router.post(
  '/team/:memberId/resend-invitation',
  team,
  asyncHandler(async (req, res) => res.json(await teamService.resendInvitation(req.admin, req.params.memberId, req)))
);
router.patch(
  '/team/:memberId/role',
  team,
  asyncHandler(async (req, res) => res.json(await teamService.changeRole(req.admin, req.params.memberId, req.body, req)))
);
router.post(
  '/team/:memberId/deactivate',
  team,
  asyncHandler(async (req, res) => res.json(await teamService.deactivate(req.admin, req.params.memberId, req)))
);
router.post(
  '/team/:memberId/reactivate',
  team,
  asyncHandler(async (req, res) => res.json(await teamService.reactivate(req.admin, req.params.memberId, req.body, req)))
);
router.delete(
  '/team/:memberId',
  team,
  asyncHandler(async (req, res) => res.json(await teamService.remove(req.admin, req.params.memberId, req)))
);

/* ------------------------------ audit trail ------------------------------ */
router.get(
  '/actions',
  requirePermission('actions:read'),
  asyncHandler(async (req, res) => {
    res.json(await adminActionLogService.list(req.query));
  })
);

module.exports = router;
