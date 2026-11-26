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

/**
 * The kitchen's own operations (mounted at /vendor). Every route needs a
 * kitchen session; staff need the permission named on the route, and the
 * services check the department again once the record is known.
 */
const router = Router();
const k = (req) => req.kitchenAccess;
const json = (fn, status = 200) => asyncHandler(async (req, res) => res.status(status).json(await fn(req)));
const auth = [requireVendorAuth];
const act = [requireVendorAuth, requireApprovedVendor];

// Who is signed in, what they may do, and their badge counts.
router.get('/workspace', ...auth, json((req) => operationsService.workspace(k(req))));
router.get('/permissions', ...auth, (req, res) => res.json(access.catalogue()));
router.get('/operations', ...auth, json((req) => operationsService.get(k(req))));
router.put('/operations', ...act, can.admin, json((req) => operationsService.update(k(req), req.body)));
router.get('/activity', ...auth, can('reports.activity'), json((req) => activityService.list(k(req), req.query)));

// Services & departments
router.get('/departments', ...auth, can('departments.view', 'kitchen.view_queue', 'menu.view'), json((req) => departmentService.list(k(req))));
router.post('/departments', ...act, can('departments.create'), upload.single('image'), json((req) => departmentService.create(k(req), req.body, req.file), 201));
router.get('/departments/:department_id', ...auth, can('departments.view'), json((req) => departmentService.get(k(req), req.params.department_id)));
router.patch('/departments/:department_id', ...act, can('departments.edit'), upload.single('image'), json((req) => departmentService.update(k(req), req.params.department_id, req.body, req.file)));
router.delete('/departments/:department_id', ...act, can('departments.delete'), json((req) => departmentService.remove(k(req), req.params.department_id)));
router.put('/departments/:department_id/staff', ...act, can('departments.manage_staff'), json((req) => departmentService.setStaff(k(req), req.params.department_id, req.body)));

// Roles & permissions
router.get('/roles', ...auth, can('staff.view', 'staff.manage_permissions', 'staff.assign_roles'), json((req) => roleService.list(k(req))));
router.post('/roles', ...act, can('staff.manage_permissions'), json((req) => roleService.create(k(req), req.body), 201));
router.patch('/roles/:role_id', ...act, can('staff.manage_permissions'), json((req) => roleService.update(k(req), req.params.role_id, req.body)));
router.delete('/roles/:role_id', ...act, can('staff.manage_permissions'), json((req) => roleService.remove(k(req), req.params.role_id)));

// Staff
router.get('/staff', ...auth, can('staff.view'), json((req) => staffService.list(k(req), req.query)));
router.post('/staff', ...act, can('staff.create'), json((req) => staffService.create(k(req), req.body), 201));
router.get('/staff/:staff_id', ...auth, can('staff.view'), json((req) => staffService.get(k(req), req.params.staff_id)));
router.patch('/staff/:staff_id', ...act, can('staff.edit', 'staff.assign_roles'), json((req) => staffService.update(k(req), req.params.staff_id, req.body)));
router.patch('/staff/:staff_id/status', ...act, can('staff.deactivate'), json((req) => staffService.setActive(k(req), req.params.staff_id, req.body)));
router.delete('/staff/:staff_id', ...act, can('staff.deactivate'), json((req) => staffService.remove(k(req), req.params.staff_id)));

// Tables & QR codes
router.get('/tables', ...auth, can('tables.view'), json((req) => tableService.list(k(req))));
router.post('/tables', ...act, can('tables.create'), json((req) => tableService.create(k(req), req.body), 201));
router.post('/tables/batch', ...act, can('tables.create'), json((req) => tableService.createBatch(k(req), req.body), 201));
router.get('/tables/:table_id', ...auth, can('tables.view'), json((req) => tableService.get(k(req), req.params.table_id)));
router.get('/tables/:table_id/seat-balances', ...auth, can('tables.view', 'invoices.view', 'invoices.process_payment'), json((req) => tablePaymentService.staffSeatBalances(k(req), req.params.table_id)));
router.post('/tables/:table_id/seat-payments', ...act, can('invoices.process_payment'), json((req) => tablePaymentService.recordStaffPayment(k(req), req.params.table_id, req.body)));
router.patch('/tables/:table_id', ...act, can('tables.edit', 'tables.assign'), json((req) => tableService.update(k(req), req.params.table_id, req.body)));
router.delete('/tables/:table_id', ...act, can('tables.delete'), json((req) => tableService.remove(k(req), req.params.table_id)));
router.post('/tables/:table_id/session/close', ...act, can('tables.edit', 'tables.assign'), json((req) => tableService.closeDiningSession(k(req), req.params.table_id)));
router.post('/tables/:table_id/seats/:seat_number/release', ...act, can('tables.assign'), json((req) => tableService.releaseSeat(k(req), req.params.table_id, req.params.seat_number, req.body)));
router.post('/tables/:table_id/qr/rotate', ...act, can('tables.qr'), json((req) => tableService.rotateToken(k(req), req.params.table_id)));
router.post('/tables/:table_id/seats/:seat_number/qr/rotate', ...act, can('tables.qr'), json((req) => tableService.rotateSeatToken(k(req), req.params.table_id, req.params.seat_number)));
router.get(
  '/tables/:table_id/qr',
  ...auth,
  can('tables.qr'),
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
  can('kitchen.accept_tasks', 'kitchen.start_preparation', 'kitchen.mark_ready'),
  json((req) => ticketService.advance(req.vendor, k(req), req.params.order_id, req.params.ticket_id, req.body))
);

// Service: ready items, collection, serving
router.get('/service/board', ...auth, can('service.view_ready'), json((req) => serviceService.board(k(req), req.query)));
router.post('/service/orders/:order_id/collect', ...act, can('service.collect'), json((req) => serviceService.collect(k(req), req.params.order_id, req.body)));
router.post('/service/orders/:order_id/serve', ...act, can('service.serve'), json((req) => serviceService.serve(k(req), req.params.order_id, req.body)));

// Invoices & payments
router.get('/invoices', ...auth, can('invoices.view'), json((req) => invoiceService.list(k(req), req.query)));
router.post('/invoices', ...act, can('invoices.generate'), json((req) => invoiceService.generate(k(req), req.body), 201));
router.get('/invoices/:invoice_id', ...auth, can('invoices.view'), json((req) => invoiceService.get(k(req), req.params.invoice_id)));
router.patch('/invoices/:invoice_id', ...act, can('invoices.edit'), json((req) => invoiceService.edit(k(req), req.params.invoice_id, req.body)));
router.post('/invoices/:invoice_id/payments', ...act, can('invoices.process_payment'), json((req) => invoiceService.recordPayment(k(req), req.params.invoice_id, req.body)));
router.post('/invoices/:invoice_id/refunds', ...act, can('invoices.refund'), json((req) => invoiceService.refund(k(req), req.params.invoice_id, req.body)));
router.post('/invoices/:invoice_id/close', ...act, can('invoices.edit', 'tables.assign'), json((req) => invoiceService.close(k(req), req.params.invoice_id)));

// Inventory & suppliers
router.get('/inventory', ...auth, can('inventory.view'), json((req) => inventoryService.list(k(req), req.query)));
router.post('/inventory', ...act, can('inventory.add'), json((req) => inventoryService.create(k(req), req.body), 201));
router.get('/inventory/movements', ...auth, can('inventory.view'), json((req) => inventoryService.movements(k(req), req.query)));
router.patch('/inventory/:item_id', ...act, can('inventory.update'), json((req) => inventoryService.update(k(req), req.params.item_id, req.body)));
router.delete('/inventory/:item_id', ...act, can('inventory.remove'), json((req) => inventoryService.remove(k(req), req.params.item_id)));
router.post('/inventory/:item_id/adjust', ...act, can('inventory.update', 'inventory.remove', 'inventory.add'), json((req) => inventoryService.adjust(k(req), req.params.item_id, req.body)));
router.get('/suppliers', ...auth, can('inventory.suppliers', 'inventory.view'), json((req) => inventoryService.listSuppliers(k(req))));
router.post('/suppliers', ...act, can('inventory.suppliers'), json((req) => inventoryService.createSupplier(k(req), req.body), 201));
router.patch('/suppliers/:supplier_id', ...act, can('inventory.suppliers'), json((req) => inventoryService.updateSupplier(k(req), req.params.supplier_id, req.body)));
router.delete('/suppliers/:supplier_id', ...act, can('inventory.suppliers'), json((req) => inventoryService.removeSupplier(k(req), req.params.supplier_id)));

// Reports (daily, weekly, monthly, yearly; saved automatically when a period ends)
router.get('/reports', ...auth, can('reports.sales', 'reports.departments'), json((req) => reportService.get(k(req), req.query)));
router.get('/reports/today', ...auth, can('reports.sales', 'reports.departments'), json((req) => reportService.today(k(req))));
router.get('/reports/history', ...auth, can('reports.sales'), json((req) => reportService.history(k(req), req.query)));
router.get(
  '/reports/export',
  ...auth,
  can('reports.sales', 'reports.departments'),
  asyncHandler(async (req, res) => {
    const { filename, body } = await reportService.exportCsv(k(req), req.query);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(body);
  })
);

module.exports = router;
