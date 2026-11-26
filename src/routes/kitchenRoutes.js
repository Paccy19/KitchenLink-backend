const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const requireVendorAuth = require('../middleware/requireVendorAuth');
const requireApprovedVendor = require('../middleware/requireApprovedVendor');
const can = require('../middleware/requireKitchenPermission');
const upload = require('../middleware/upload');
const access = require('../config/kitchenAccess');
const departmentService = require('../services/kitchen/departmentService');
const { roleService, staffService } = require('../services/kitchen/staffService');
const tableService = require('../services/kitchen/tableService');
const ticketService = require('../services/kitchen/ticketService');
const serviceService = require('../services/kitchen/serviceService');
const invoiceService = require('../services/kitchen/invoiceService');
const tablePaymentService = require('../services/kitchen/tablePaymentService');
const inventoryService = require('../services/kitchen/inventoryService');
const reportService = require('../services/kitchen/reportService');
const operationsService = require('../services/kitchen/operationsService');
const activityService = require('../services/kitchen/activityService');
const orderOps = require('../services/kitchen/orderOpsService');
const serviceRequests = require('../services/kitchen/serviceRequestService');
const financeService = require('../services/kitchen/financeService');
const customerService = require('../services/kitchen/customerService');
const reservationService = require('../services/kitchen/reservationService');
const promotionService = require('../services/kitchen/promotionService');
const teamService = require('../services/kitchen/teamService');
const { inbox } = require('../services/kitchen/alertService');
const sessionService = require('../services/kitchen/sessionService');
const packingService = require('../services/kitchen/packingService');
const deliveryBoard = require('../services/kitchen/deliveryBoardService');

/**
 * The kitchen's own operations (mounted at /vendor). Every route needs a
 * kitchen session; staff need the permission named on the route, and the
 * services check the department again once the record is known.
 */
const router = Router();
// Anyone who may see some part of a report (the service keeps only those parts).
const REPORT_PERMISSIONS = [
  'reports.sales', 'reports.orders', 'reports.products', 'reports.departments', 'reports.employees', 'reports.inventory',
  'reports.financial', 'reports.payments', 'finance.revenue', 'finance.department_revenue', 'finance.payment_summaries',
  'overview.department_performance', 'overview.financial_summary', 'departments.performance', 'staff.view_performance',
  'invoices.cashier_reports', 'inventory.reports', 'reports.customers',
];
const k = (req) => req.kitchenAccess;
const json = (fn, status = 200) => asyncHandler(async (req, res) => res.status(status).json(await fn(req)));
const auth = [requireVendorAuth];
const act = [requireVendorAuth, requireApprovedVendor];

// Who is signed in, what they may do, and their badge counts.
router.get('/workspace', ...auth, json((req) => operationsService.workspace(k(req))));
router.get('/permissions', ...auth, (req, res) => res.json({ ...access.catalogue(), routes: require('../config/routeAccess').all() }));
router.get('/operations', ...auth, json((req) => operationsService.get(k(req))));
router.put('/operations', ...act, can('settings.operational_rules', 'finance.settings', 'settings.payment_preferences', 'settings.notifications', 'notifications.order_alerts', 'notifications.employee_alerts', 'customers.loyalty', 'reservations.edit', 'reservations.deposits'), json((req) => operationsService.update(k(req), req.body)));
router.get('/activity', ...auth, can('audit.kitchen_logs', 'audit.employee_logs', 'audit.financial_logs', 'audit.permission_changes', 'audit.login_history', 'audit.security_events', 'overview.activity_logs', 'staff.view_activity', 'roles.history'), json((req) => activityService.list(k(req), req.query)));

// Services & departments
router.get('/departments', ...auth, can('departments.view', 'kitchen.view_queue', 'menu.view', 'departments.performance'), json((req) => departmentService.list(k(req))));
router.post('/departments', ...act, can('departments.create'), upload.single('image'), json((req) => departmentService.create(k(req), req.body, req.file), 201));
router.get('/departments/:department_id', ...auth, can('departments.view'), json((req) => departmentService.get(k(req), req.params.department_id)));
router.patch('/departments/:department_id', ...act, can('departments.edit', 'departments.activate', 'departments.availability', 'departments.manage_hours', 'departments.configure_workflow', 'departments.settings', 'kitchen.manage_stations', 'kitchen.workflows'), upload.single('image'), json((req) => departmentService.update(k(req), req.params.department_id, req.body, req.file)));
router.delete('/departments/:department_id', ...act, can('departments.delete'), json((req) => departmentService.remove(k(req), req.params.department_id)));
router.put('/departments/:department_id/staff', ...act, can('departments.manage_staff', 'staff.assign_departments'), json((req) => departmentService.setStaff(k(req), req.params.department_id, req.body)));

// Roles & permissions
router.get('/roles', ...auth, can('roles.view', ...access.inGroup('staff')), json((req) => roleService.list(k(req))));
// Roles and the permissions in them: kitchen administrators only.
router.post('/roles', ...act, can.admin, json((req) => roleService.create(k(req), req.body), 201));
router.patch('/roles/:role_id', ...act, can.admin, json((req) => roleService.update(k(req), req.params.role_id, req.body)));
router.delete('/roles/:role_id', ...act, can.admin, json((req) => roleService.remove(k(req), req.params.role_id)));

// Staff
router.get('/staff', ...auth, can(...access.inGroup('staff')), json((req) => staffService.list(k(req), req.query)));
router.post('/staff', ...act, can('staff.create'), json((req) => staffService.create(k(req), req.body), 201));
router.get('/staff/:staff_id', ...auth, can('staff.view'), json((req) => staffService.get(k(req), req.params.staff_id)));
router.patch('/staff/:staff_id', ...act, can('staff.edit', 'staff.reset_passwords', 'staff.assign_departments'), json((req) => staffService.update(k(req), req.params.staff_id, req.body)));
router.patch('/staff/:staff_id/status', ...act, can('staff.deactivate'), json((req) => staffService.setActive(k(req), req.params.staff_id, req.body)));
router.post('/staff/:staff_id/sign-out', ...act, can('audit.revoke_sessions'), json((req) => staffService.signOutEverywhere(k(req), req.params.staff_id)));
router.delete('/staff/:staff_id', ...act, can('staff.delete'), json((req) => staffService.remove(k(req), req.params.staff_id)));

// Tables & QR codes
router.get('/tables', ...auth, can('tables.view', 'service.table_info'), json((req) => tableService.list(k(req))));
router.post('/tables', ...act, can('tables.create'), json((req) => tableService.create(k(req), req.body), 201));
router.post('/tables/batch', ...act, can('tables.create'), json((req) => tableService.createBatch(k(req), req.body), 201));
router.get('/tables/:table_id', ...auth, can('tables.view', 'tables.sessions_view', 'tables.order_history', 'service.table_info'), json((req) => tableService.get(k(req), req.params.table_id)));
router.get('/tables/:table_id/seat-balances', ...auth, can('tables.view', 'invoices.view', 'invoices.process_payment', 'invoices.cash', 'invoices.digital'), json((req) => tablePaymentService.staffSeatBalances(k(req), req.params.table_id)));
router.post('/tables/:table_id/seat-payments', ...act, can('invoices.process_payment', 'invoices.cash', 'invoices.digital'), json((req) => tablePaymentService.recordStaffPayment(k(req), req.params.table_id, req.body)));
router.patch('/tables/:table_id', ...act, can('tables.edit', 'tables.activate', 'service.assign_servers', 'service.transfer_servers', 'reservations.table_availability'), json((req) => tableService.update(k(req), req.params.table_id, req.body)));
router.delete('/tables/:table_id', ...act, can('tables.delete'), json((req) => tableService.remove(k(req), req.params.table_id)));
router.post('/tables/:table_id/session/close', ...act, can('tables.close_sessions', 'tables.edit'), json((req) => tableService.closeDiningSession(k(req), req.params.table_id)));
router.post('/tables/:table_id/seats/:seat_number/release', ...act, can('tables.close_sessions', 'tables.seat'), json((req) => tableService.releaseSeat(k(req), req.params.table_id, req.params.seat_number, req.body)));
router.post('/tables/:table_id/qr/rotate', ...act, can('tables.qr_regenerate'), json((req) => tableService.rotateToken(k(req), req.params.table_id)));
router.post('/tables/:table_id/seats/:seat_number/qr/rotate', ...act, can('tables.qr_regenerate'), json((req) => tableService.rotateSeatToken(k(req), req.params.table_id, req.params.seat_number)));
router.get(
  '/tables/:table_id/qr',
  ...auth,
  can('tables.qr_generate', 'tables.qr_download', 'tables.qr_print'),
  asyncHandler(async (req, res) => {
    const { type, body, table, seat } = await tableService.qr(
      k(req),
      req.params.table_id,
      req.query.format === 'png' ? 'png' : 'svg',
      req.query.seat
    );
    const suffix = seat ? `-seat-${String(seat.seat_number).padStart(2, '0')}` : '';
    const name = `table-${table.label.replace(/[^A-Za-z0-9]+/g, '-')}${suffix}-qr.${type === 'image/png' ? 'png' : 'svg'}`;
    res.set('Content-Type', type);
    res.set('Cache-Control', 'private, no-store');
    if (req.query.download === '1') res.set('Content-Disposition', `attachment; filename="${name}"`);
    res.send(body);
  })
);

// Preparation queues (department tickets)
router.get('/kitchen/queue', ...auth, can('kitchen.view_queue'), json((req) => ticketService.queue(k(req), req.query)));
router.patch(
  '/kitchen/orders/:order_id/tickets/:ticket_id',
  ...act,
  can('kitchen.accept_tasks', 'kitchen.start_preparation', 'kitchen.update_progress', 'kitchen.mark_ready'),
  json((req) => ticketService.advance(req.vendor, k(req), req.params.order_id, req.params.ticket_id, req.body))
);

// Service: ready items, collection, serving
router.get('/service/board', ...auth, can('service.view_ready', 'service.takeaway', 'service.dine_in', 'delivery.view_orders', 'service.view_assigned'), json((req) => serviceService.board(k(req), req.query)));
router.post('/service/orders/:order_id/collect', ...act, can('service.collect', 'kitchen.item_handover'), json((req) => serviceService.collect(k(req), req.params.order_id, req.body)));
router.post('/service/orders/:order_id/serve', ...act, can('service.serve', 'service.dine_in'), json((req) => serviceService.serve(k(req), req.params.order_id, req.body)));

// Invoices & payments
router.get('/invoices', ...auth, can('invoices.view', 'invoices.process_payment', 'invoices.cash', 'invoices.digital', 'invoices.partial', 'invoices.payment_history', 'invoices.receipts', 'invoices.print', 'invoices.download', 'invoices.outstanding'), json((req) => invoiceService.list(k(req), req.query)));
router.post('/invoices', ...act, can('invoices.generate'), json((req) => invoiceService.generate(k(req), req.body), 201));
router.get('/invoices/:invoice_id/document', ...auth, can('invoices.print', 'invoices.download', 'invoices.receipts', 'invoices.view', 'invoices.process_payment', 'invoices.cash', 'invoices.digital'), asyncHandler(async (req, res) => {
  const doc = await invoiceService.document(k(req), req.params.invoice_id, req.query.kind === 'receipt' ? 'receipt' : 'invoice');
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  if (req.query.download === 'true') res.attachment(doc.filename);
  res.type('html').send(doc.html);
}));
router.get('/invoices/:invoice_id', ...auth, can('invoices.view', 'invoices.process_payment', 'invoices.cash', 'invoices.digital', 'invoices.partial', 'invoices.payment_history', 'invoices.receipts', 'invoices.print', 'invoices.download'), json((req) => invoiceService.get(k(req), req.params.invoice_id)));
router.patch('/invoices/:invoice_id', ...act, can('invoices.edit', 'invoices.discounts', 'promotions.manual_discounts'), json((req) => invoiceService.edit(k(req), req.params.invoice_id, req.body)));
router.post('/invoices/:invoice_id/payments', ...act, can('invoices.process_payment', 'invoices.cash', 'invoices.digital'), json((req) => invoiceService.recordPayment(k(req), req.params.invoice_id, req.body)));
router.post('/invoices/:invoice_id/refunds', ...act, can('invoices.refund', 'orders.refunds'), json((req) => invoiceService.refund(k(req), req.params.invoice_id, req.body)));
router.post('/invoices/:invoice_id/close', ...act, can('tables.close_sessions', 'reservations.manage_sessions', 'reservations.extend_close', 'invoices.edit'), json((req) => invoiceService.close(k(req), req.params.invoice_id)));

// Inventory & suppliers
router.get('/inventory', ...auth, can(...access.inGroup('inventory')), json((req) => inventoryService.list(k(req), req.query)));
router.post('/inventory', ...act, can('inventory.add', 'inventory.ingredients', 'inventory.raw_materials'), json((req) => inventoryService.create(k(req), req.body), 201));
router.get('/inventory/movements', ...auth, can('inventory.movements', 'inventory.view'), json((req) => inventoryService.movements(k(req), req.query)));
router.patch('/inventory/categories', ...act, can('inventory.categories'), json((req) => inventoryService.renameCategory(k(req), req.body)));
router.patch('/inventory/:item_id', ...act, can('inventory.update', 'inventory.low_stock_alerts', 'inventory.ingredients', 'inventory.raw_materials'), json((req) => inventoryService.update(k(req), req.params.item_id, req.body)));
router.delete('/inventory/:item_id', ...act, can('inventory.remove'), json((req) => inventoryService.remove(k(req), req.params.item_id)));
router.post('/inventory/:item_id/adjust', ...act, can('inventory.adjust', 'inventory.update', 'inventory.remove', 'inventory.add', 'inventory.receive_deliveries', 'inventory.waste'), json((req) => inventoryService.adjust(k(req), req.params.item_id, req.body)));
router.get('/suppliers', ...auth, can(...access.inGroup('inventory')), json((req) => inventoryService.listSuppliers(k(req))));
router.post('/suppliers', ...act, can('inventory.suppliers'), json((req) => inventoryService.createSupplier(k(req), req.body), 201));
router.patch('/suppliers/:supplier_id', ...act, can('inventory.suppliers'), json((req) => inventoryService.updateSupplier(k(req), req.params.supplier_id, req.body)));
router.delete('/suppliers/:supplier_id', ...act, can('inventory.suppliers'), json((req) => inventoryService.removeSupplier(k(req), req.params.supplier_id)));

// Reports (daily, weekly, monthly, yearly; saved automatically when a period ends)
router.get('/reports', ...auth, can(...REPORT_PERMISSIONS), json((req) => reportService.get(k(req), req.query)));
router.get('/reports/today', ...auth, can(...REPORT_PERMISSIONS), json((req) => reportService.today(k(req))));
router.get('/reports/history', ...auth, can('reports.historical'), json((req) => reportService.history(k(req), req.query)));
router.get(
  '/reports/export',
  ...auth,
  can('reports.export', 'finance.export'),
  asyncHandler(async (req, res) => {
    const { filename, body } = await reportService.exportCsv(k(req), req.query);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(body);
  })
);

// Orders: priority, assignment, editing items, departments, reopening, history, tables, couriers.
// (Each service call checks the exact permission, e.g. orders.add_items or tables.transfer_orders.)
router.patch('/orders/:order_id/priority', ...act, can('orders.priorities'), json((req) => orderOps.priority(k(req), req.params.order_id, req.body)));
router.patch('/orders/:order_id/assign', ...act, can('orders.assign_employees', 'service.assign_servers', 'service.transfer_servers'), json((req) => orderOps.assign(k(req), req.params.order_id, req.body)));
router.post('/orders/:order_id/items', ...act, can('orders.add_items', 'orders.edit'), json((req) => orderOps.addItem(k(req), req.params.order_id, req.body), 201));
router.patch('/orders/:order_id/items/:item_id', ...act, can('orders.quantities', 'orders.edit'), json((req) => orderOps.setQuantity(k(req), req.params.order_id, req.params.item_id, req.body)));
router.delete('/orders/:order_id/items/:item_id', ...act, can('orders.remove_items', 'orders.edit'), json((req) => orderOps.removeItem(k(req), req.params.order_id, req.params.item_id)));
router.patch('/orders/:order_id/items/:item_id/department', ...act, can('orders.assign_departments'), json((req) => orderOps.moveItem(k(req), req.params.order_id, req.params.item_id, req.body)));
router.post('/orders/:order_id/reopen', ...act, can('orders.reopen', 'kitchen.completed'), json((req) => orderOps.reopen(k(req), req.params.order_id, req.body)));
router.get('/orders/:order_id/history', ...auth, can('audit.order_history', 'orders.details', 'orders.view'), json((req) => orderOps.history(k(req), req.params.order_id)));
router.put('/orders/:order_id/table', ...act, can('tables.assign_orders', 'tables.transfer_orders'), json((req) => orderOps.setTable(k(req), req.params.order_id, req.body)));
router.post('/orders/:order_id/claim', ...act, can('service.accept_collection'), json((req) => orderOps.claim(k(req), req.params.order_id)));
router.put('/orders/:order_id/courier', ...act, can('delivery.create_assignments', 'delivery.assign_workers', 'delivery.change_assignments'), json((req) => orderOps.setCourier(k(req), req.params.order_id, req.body)));
router.delete('/orders/:order_id/courier', ...act, can('delivery.cancel_assignments'), json((req) => orderOps.cancelCourier(k(req), req.params.order_id)));
router.patch('/orders/:order_id/courier/status', ...act, can('delivery.drive', 'service.view_assigned', 'delivery.change_assignments', 'delivery.track'), json((req) => orderOps.courierStatus(k(req), req.params.order_id, req.body)));

// Preparation tickets: pause, cancel, assign.
router.patch('/kitchen/orders/:order_id/tickets/:ticket_id/pause', ...act, can('kitchen.pause'), json((req) => ticketService.pause(req.vendor, k(req), req.params.order_id, req.params.ticket_id, req.body)));
router.post('/kitchen/orders/:order_id/tickets/:ticket_id/cancel', ...act, can('kitchen.cancel_tasks'), json((req) => ticketService.cancelTicket(req.vendor, k(req), req.params.order_id, req.params.ticket_id, req.body)));
router.patch('/kitchen/orders/:order_id/tickets/:ticket_id/assign', ...act, can('kitchen.assign_tasks'), json((req) => ticketService.assignTicket(req.vendor, k(req), req.params.order_id, req.params.ticket_id, req.body)));
router.post('/kitchen/orders/:order_id/tickets/:ticket_id/flags', ...act, can('kitchen.flag_issues'), json((req) => ticketService.flag(req.vendor, k(req), req.params.order_id, req.params.ticket_id, req.body), 201));
router.post('/kitchen/orders/:order_id/tickets/:ticket_id/flags/:index/resolve', ...act, can('kitchen.flag_issues', 'service.view_assigned', 'orders.edit'), json((req) => ticketService.resolveFlag(req.vendor, k(req), req.params.order_id, req.params.ticket_id, req.params.index)));

// The floor: table visits, seating, the waiting list (host, servers, managers).
const FLOOR = ['tables.seat', 'tables.view', 'tables.sessions_view', 'tables.waitlist', 'reservations.check_in', 'service.view_assigned'];
const SESSION_VIEW = ['tables.sessions_view', 'tables.view', 'tables.seat', 'service.view_assigned', 'reservations.active_sessions', 'reservations.manage_sessions'];
router.get('/floor', ...auth, can(...FLOOR), json((req) => sessionService.board(k(req))));
router.get('/table-sessions', ...auth, can(...SESSION_VIEW), json((req) => sessionService.list(k(req), req.query)));
router.post('/table-sessions', ...act, can('tables.seat'), json((req) => sessionService.seat(k(req), req.body), 201));
router.get('/table-sessions/:session_id', ...auth, can(...SESSION_VIEW), json((req) => sessionService.get(k(req), req.params.session_id)));
router.patch('/table-sessions/:session_id', ...act, can('tables.seat', 'tables.sessions_view', 'service.view_assigned'), json((req) => sessionService.update(k(req), req.params.session_id, req.body)));
router.put('/table-sessions/:session_id/server', ...act, can('service.assign_servers', 'service.transfer_servers', 'tables.seat'), json((req) => sessionService.assignServer(k(req), req.params.session_id, req.body)));
router.post('/table-sessions/:session_id/transfer', ...act, can('tables.transfer_sessions'), json((req) => sessionService.transfer(k(req), req.params.session_id, req.body)));
router.get('/table-sessions/:session_id/menu', ...auth, can('service.order_for_guests'), json((req) => sessionService.menu(k(req), req.params.session_id)));
router.post('/table-sessions/:session_id/orders', ...act, can('service.order_for_guests'), json((req) => sessionService.order(k(req), req.params.session_id, req.body), 201));
router.post('/table-sessions/:session_id/close', ...act, can('tables.close_sessions', 'reservations.manage_sessions', 'reservations.extend_close'), json((req) => sessionService.close(k(req), req.params.session_id, req.body)));
router.get('/waitlist', ...auth, can('tables.waitlist', 'tables.seat'), json((req) => sessionService.waitlist(k(req))));
router.post('/waitlist', ...act, can('tables.waitlist', 'tables.seat'), json((req) => sessionService.addToWaitlist(k(req), req.body), 201));
router.patch('/waitlist/:entry_id', ...act, can('tables.waitlist', 'tables.seat'), json((req) => sessionService.updateWaitlist(k(req), req.params.entry_id, req.body)));

// Packing: leftovers (no charge), takeaway from a dine-in order, delivery and pickup orders.
router.get('/packing', ...auth, can('packing.view'), json((req) => packingService.list(k(req), req.query)));
router.post('/packing/:task_id/pack', ...act, can('packing.pack'), json((req) => packingService.pack(k(req), req.params.task_id)));
router.post('/packing/:task_id/handover', ...act, can('packing.handover', 'service.request_packing'), json((req) => packingService.handover(k(req), req.params.task_id)));
router.post('/packing/:task_id/issue', ...act, can('packing.report_issue', 'packing.pack'), json((req) => packingService.reportIssue(k(req), req.params.task_id, req.body)));
router.post('/orders/:order_id/leftovers', ...act, can('service.request_packing', 'packing.pack'), json((req) => packingService.requestLeftovers(k(req), req.params.order_id, req.body), 201));
router.post('/orders/:order_id/takeaway', ...act, can('orders.change_fulfillment', 'service.request_packing'), json((req) => packingService.convertToTakeaway(k(req), req.params.order_id, req.body), 201));
router.get('/orders/:order_id/packing', ...auth, can('packing.view', 'service.request_packing', 'service.view_assigned'), json((req) => packingService.forOrder(k(req), req.params.order_id)));

// Deliveries: the coordinator's board, or a kitchen driver's own deliveries.
router.get('/deliveries', ...auth, can('delivery.view_orders', 'delivery.assign_workers', 'delivery.create_assignments', 'delivery.change_assignments', 'delivery.track', 'delivery.drive'), json((req) => deliveryBoard.board(k(req), req.query)));

// Tables: merging; bills: split, cancel, codes, customers, loyalty points.
router.post('/tables/:table_id/merge', ...act, can('tables.merge'), json((req) => invoiceService.mergeTables(k(req), req.params.table_id, req.body?.from_table_id)));
router.post('/invoices/:invoice_id/split', ...act, can('invoices.split', 'tables.split_bills'), json((req) => invoiceService.split(k(req), req.params.invoice_id, req.body)));
router.post('/invoices/:invoice_id/cancel', ...act, can('invoices.cancel'), json((req) => invoiceService.cancel(k(req), req.params.invoice_id, req.body)));
router.post('/invoices/:invoice_id/apply-code', ...act, can('invoices.discounts', 'promotions.manual_discounts', 'invoices.process_payment', 'invoices.edit'), json((req) => promotionService.applyCode(k(req), req.params.invoice_id, req.body)));
router.put('/invoices/:invoice_id/customer', ...act, can('invoices.edit', 'customers.loyalty', 'customers.discounts', 'invoices.process_payment'), json((req) => customerService.attachToInvoice(k(req), req.params.invoice_id, req.body)));
router.post('/invoices/:invoice_id/redeem-points', ...act, can('customers.loyalty'), json((req) => customerService.redeemPoints(k(req), req.params.invoice_id, req.body)));

// Guests asking from their table.
router.get('/service/requests', ...auth, can('service.customer_requests'), json((req) => serviceRequests.list(k(req), req.query)));
router.patch('/service/requests/:request_id', ...act, can('service.customer_requests'), json((req) => serviceRequests.update(k(req), req.params.request_id, req.body)));

// Cashier tills and cashier reports.
router.get('/cashier/sessions', ...auth, can('invoices.cashier_sessions', 'invoices.cashier_reports', 'invoices.process_payment', 'invoices.cash'), json((req) => financeService.sessions(k(req), req.query)));
router.post('/cashier/sessions', ...act, can('invoices.cashier_sessions', 'invoices.process_payment', 'invoices.cash'), json((req) => financeService.openSession(k(req), req.body), 201));
router.post('/cashier/sessions/:session_id/close', ...act, can('invoices.cashier_sessions', 'invoices.process_payment', 'invoices.cash'), json((req) => financeService.closeSession(k(req), req.params.session_id, req.body)));
router.get('/cashier/report', ...auth, can('invoices.cashier_reports', 'reports.payments', 'reports.financial'), json((req) => financeService.cashierReport(k(req), req.query)));

// Finance: expenses, profit and loss, transactions.
router.get('/finance/expenses', ...auth, can('finance.expenses_view', 'finance.expenses_record', 'finance.expenses_edit', 'finance.expenses_delete'), json((req) => financeService.listExpenses(k(req), req.query)));
router.post('/finance/expenses', ...act, can('finance.expenses_record'), json((req) => financeService.createExpense(k(req), req.body), 201));
router.patch('/finance/expenses/:expense_id', ...act, can('finance.expenses_edit'), json((req) => financeService.updateExpense(k(req), req.params.expense_id, req.body)));
router.delete('/finance/expenses/:expense_id', ...act, can('finance.expenses_delete'), json((req) => financeService.deleteExpense(k(req), req.params.expense_id)));
router.get('/finance/profit-loss', ...auth, can('finance.profit_loss'), json((req) => financeService.profitAndLoss(k(req), req.query)));
router.get('/finance/transactions', ...auth, can('finance.transactions'), json((req) => financeService.transactions(k(req), req.query)));

// Stock: categories, transfers between departments, purchase orders.
router.post('/inventory/:item_id/transfer', ...act, can('inventory.transfers'), json((req) => inventoryService.transfer(k(req), req.params.item_id, req.body)));
router.get('/purchase-orders', ...auth, can('inventory.purchase_orders', 'inventory.receive_deliveries'), json((req) => inventoryService.listPurchaseOrders(k(req), req.query)));
router.post('/purchase-orders', ...act, can('inventory.purchase_orders'), json((req) => inventoryService.createPurchaseOrder(k(req), req.body), 201));
router.patch('/purchase-orders/:po_id', ...act, can('inventory.purchase_orders'), json((req) => inventoryService.updatePurchaseOrder(k(req), req.params.po_id, req.body)));
router.post('/purchase-orders/:po_id/receive', ...act, can('inventory.receive_deliveries', 'inventory.purchase_orders'), json((req) => inventoryService.receivePurchaseOrder(k(req), req.params.po_id, req.body)));

// Customers, loyalty, feedback and reviews, messages to customers.
router.get('/customers', ...auth, can(...access.inGroup('customers')), json((req) => customerService.list(k(req), req.query)));
router.post('/customers', ...act, can('customers.manage'), json((req) => customerService.create(k(req), req.body), 201));
router.post('/customers/notify', ...act, can('notifications.customer'), json((req) => customerService.notify(k(req), req.body)));
router.get('/customers/:customer_id', ...auth, can('customers.profiles'), json((req) => customerService.get(k(req), req.params.customer_id)));
router.patch('/customers/:customer_id', ...act, can('customers.manage', 'customers.discounts'), json((req) => customerService.update(k(req), req.params.customer_id, req.body)));
router.post('/customers/:customer_id/points', ...act, can('customers.loyalty'), json((req) => customerService.adjustPoints(k(req), req.params.customer_id, req.body)));
router.get('/feedback', ...auth, can('customers.feedback', 'customers.reviews'), json((req) => customerService.listFeedback(k(req), req.query)));
router.post('/feedback/:feedback_id/reply', ...act, can('customers.complaints'), json((req) => customerService.reply(k(req), req.params.feedback_id, req.body)));

// Reservations and dining sessions.
router.get('/reservations', ...auth, can(...access.inGroup('reservations')), json((req) => reservationService.list(k(req), req.query)));
router.post('/reservations', ...act, can('reservations.create'), json((req) => reservationService.create(k(req), req.body), 201));
router.get('/reservations/availability', ...auth, can('reservations.table_availability', 'reservations.assign_tables', 'reservations.view'), json((req) => reservationService.availability(k(req), req.query)));
router.patch('/reservations/:reservation_id', ...act, can('reservations.edit', 'reservations.cancel', 'reservations.assign_tables', 'reservations.manage_sessions', 'reservations.extend_close'), json((req) => reservationService.update(k(req), req.params.reservation_id, req.body)));
router.get('/reservations/:reservation_id', ...auth, can('reservations.view'), json((req) => reservationService.get(k(req), req.params.reservation_id)));
router.post('/reservations/:reservation_id/confirm', ...act, can('reservations.confirm'), json((req) => reservationService.confirm(k(req), req.params.reservation_id)));
router.post('/reservations/:reservation_id/reject', ...act, can('reservations.confirm'), json((req) => reservationService.reject(k(req), req.params.reservation_id, req.body)));
router.post('/reservations/:reservation_id/arrive', ...act, can('reservations.check_in', 'tables.seat'), json((req) => reservationService.arrive(k(req), req.params.reservation_id)));
router.post('/reservations/:reservation_id/seat', ...act, can('reservations.manage_sessions', 'tables.seat'), json((req) => reservationService.seat(k(req), req.params.reservation_id, req.body)));
router.post('/reservations/:reservation_id/cancel', ...act, can('reservations.cancel'), json((req) => reservationService.cancel(k(req), req.params.reservation_id, req.body)));
router.post('/reservations/:reservation_id/no-show', ...act, can('reservations.cancel', 'reservations.edit', 'reservations.check_in'), json((req) => reservationService.noShow(k(req), req.params.reservation_id)));
router.post('/reservations/:reservation_id/deposit', ...act, can('reservations.deposits'), json((req) => reservationService.recordDeposit(k(req), req.params.reservation_id, req.body)));
router.get('/sessions', ...auth, can('reservations.active_sessions', 'tables.sessions_view', 'reservations.manage_sessions'), json((req) => reservationService.sessions(k(req))));

// Promotions: discount codes and automatic campaigns.
router.get('/promotions', ...auth, can(...access.inGroup('promotions'), 'menu.promotions'), json((req) => promotionService.list(k(req))));
router.post('/promotions', ...act, can('promotions.create'), json((req) => promotionService.create(k(req), req.body), 201));
router.patch('/promotions/:promotion_id', ...act, can('promotions.edit'), json((req) => promotionService.update(k(req), req.params.promotion_id, req.body)));
router.delete('/promotions/:promotion_id', ...act, can('promotions.delete'), json((req) => promotionService.remove(k(req), req.params.promotion_id)));

// Team inbox (messages and alerts) — everyone signed in reads their own.
router.get('/inbox', ...auth, json((req) => inbox.list(k(req), req.query)));
router.post('/inbox', ...act, can('notifications.internal'), json((req) => inbox.send(k(req), req.body), 201));
router.post('/inbox/read-all', ...auth, json((req) => inbox.markAllRead(k(req))));
router.post('/inbox/:notification_id/read', ...auth, json((req) => inbox.markRead(k(req), req.params.notification_id)));
router.get('/inbox/preferences', ...auth, json((req) => inbox.getPreferences(k(req))));
router.put('/inbox/preferences', ...auth, json((req) => inbox.setPreferences(k(req), req.body)));

// Team: invitations, schedules, attendance.
router.post('/staff/:staff_id/invite', ...act, can('staff.invite'), json((req) => teamService.invite(k(req), req.params.staff_id)));
router.get('/shifts', ...auth, json((req) => teamService.shifts(k(req), req.query)));
router.post('/shifts', ...act, can('staff.schedules'), json((req) => teamService.createShift(k(req), req.body), 201));
router.patch('/shifts/:shift_id', ...act, can('staff.schedules'), json((req) => teamService.updateShift(k(req), req.params.shift_id, req.body)));
router.delete('/shifts/:shift_id', ...act, can('staff.schedules'), json((req) => teamService.deleteShift(k(req), req.params.shift_id)));
router.get('/attendance', ...auth, can('staff.attendance'), json((req) => teamService.attendance(k(req), req.query)));
router.patch('/attendance/:entry_id', ...act, can('staff.attendance'), json((req) => teamService.editAttendance(k(req), req.params.entry_id, req.body)));
router.get('/attendance/me', ...auth, json((req) => teamService.myStatus(k(req))));
router.post('/attendance/clock-in', ...auth, json((req) => teamService.clockIn(k(req), req.body), 201));
router.post('/attendance/clock-out', ...auth, json((req) => teamService.clockOut(k(req))));

module.exports = router;
