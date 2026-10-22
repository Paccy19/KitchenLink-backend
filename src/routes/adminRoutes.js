const { Router } = require('express');
const requireAdminAuth = require('../middleware/requireAdminAuth');
const adminRateLimit = require('../middleware/adminRateLimit');
const requirePermission = require('../middleware/requirePermission');
const requireSuperAdmin = require('../middleware/requireSuperAdmin');
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

const asyncHandler = require('../utils/asyncHandler');

const router = Router();

router.use(requireAdminAuth);
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
router.post(
  '/vendors/:vendorId/documents/review',
  requirePermission('vendors:write'),
  adminVendorController.reviewDocuments
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
          before: { warning: previous.warning_minutes, charge: previous.charge_after_minutes, reassign: previous.reassign_after_minutes },
          after: { warning: current.warning_minutes, charge: current.charge_after_minutes, reassign: current.reassign_after_minutes },
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
