/**
 * Who can do what inside one kitchen (the kitchen's own staff, not the
 * platform admins: those are in adminAccess.js).
 *
 * - The kitchen account itself (the owner who registered it) can do
 *   everything. So can staff marked `is_admin` (kitchen administrators).
 * - Every other staff member gets the union of their roles' permissions.
 * - Permissions marked `scoped` apply per department: a grant only covers
 *   the departments of the role (role.department_ids), or else the staff
 *   member's own departments, or else the whole kitchen when neither is set.
 *   A department's managers also get DEPARTMENT_MANAGER_PERMISSIONS for it.
 * - `owner` permissions are never given to a role: only administrators have them.
 *
 * The server checks every request against these (requireKitchenPermission);
 * hiding a button in the dashboard is only for convenience.
 */

const GROUPS = [
  { id: 'overview', label: 'Kitchen Overview & Dashboard' },
  { id: 'settings', label: 'Kitchen Settings & Administration' },
  { id: 'staff', label: 'Staff & Employee Management' },
  { id: 'roles', label: 'Roles & Permissions' },
  { id: 'departments', label: 'Services & Departments' },
  { id: 'menu', label: 'Menu & Product Management' },
  { id: 'orders', label: 'Order Management' },
  { id: 'kitchen', label: 'Preparation & Kitchen Operations' },
  { id: 'tables', label: 'Table & QR Code Management' },
  { id: 'service', label: 'Server & Customer Service' },
  { id: 'packing', label: 'Packing & Fulfillment' },
  { id: 'invoices', label: 'Cashier, Invoices & Payments' },
  { id: 'finance', label: 'Financial Management' },
  { id: 'inventory', label: 'Inventory & Stock Management' },
  { id: 'delivery', label: 'Delivery Management' },
  { id: 'customers', label: 'Customer Management' },
  { id: 'reservations', label: 'Reservations & Customer Sessions' },
  { id: 'promotions', label: 'Discounts & Promotions' },
  { id: 'notifications', label: 'Notifications & Communication' },
  { id: 'reports', label: 'Reports & Analytics' },
  { id: 'audit', label: 'Audit Logs & Security' },
];

/*
 * Every permission: [key, label, flags]. Flags:
 *  S = department-scoped (covers only the role's / employee's departments),
 *  A = kitchen administrators only (never put in a role: handing out access,
 *      making administrators, the wallet),
 *  P = planned: the feature is not built yet. It can be put in a role now and
 *      starts working when the feature ships; until then it allows nothing.
 */
const LIST = {
  overview: [
    ['overview.dashboard', 'View kitchen dashboard'],
    ['overview.statistics', 'View kitchen statistics'],
    ['overview.sales', 'View total sales'],
    ['overview.orders', 'View total orders'],
    ['overview.pending_orders', 'View pending orders'],
    ['overview.active_tables', 'View active tables'],
    ['overview.active_employees', 'View active employees'],
    ['overview.department_performance', 'View department performance', 'S'],
    ['overview.financial_summary', 'View financial summaries'],
    ['overview.activity_logs', 'View business activity logs'],
  ],
  settings: [
    ['settings.view_profile', 'View kitchen profile'],
    ['settings.edit_profile', 'Edit kitchen profile'],
    ['settings.images', 'Change kitchen logo and images'],
    ['settings.contact', 'Manage kitchen contact information'],
    ['settings.hours', 'Manage operating hours'],
    ['settings.availability', 'Manage kitchen availability'],
    ['settings.kitchen_settings', 'Configure kitchen-wide settings'],
    ['settings.notifications', 'Manage kitchen notification settings'],
    ['settings.payment_preferences', 'Manage payment preferences'],
    ['settings.order_acceptance', 'Manage order acceptance settings'],
    ['settings.operational_rules', 'Manage kitchen-wide operational rules'],
    ['settings.administrators', 'Manage kitchen administrator accounts', 'A'],
  ],
  staff: [
    ['staff.view', 'View employees'],
    ['staff.create', 'Create employee accounts'],
    ['staff.edit', 'Edit employee accounts'],
    ['staff.deactivate', 'Deactivate employee accounts'],
    ['staff.delete', 'Delete employee accounts'],
    ['staff.invite', 'Invite employees'],
    ['staff.reset_passwords', 'Reset employee passwords'],
    ['staff.assign_departments', 'Assign employees to departments'],
    ['staff.assign_roles', 'Assign roles to employees', 'A'],
    ['staff.assign_multiple_roles', 'Assign multiple roles', 'A'],
    ['staff.view_activity', 'View employee activity'],
    ['staff.view_performance', 'View employee performance'],
    ['staff.schedules', 'Manage employee schedules'],
    ['staff.attendance', 'Manage employee attendance'],
  ],
  roles: [
    ['roles.view', 'View roles'],
    ['roles.create', 'Create custom roles', 'A'],
    ['roles.edit', 'Edit roles', 'A'],
    ['roles.delete', 'Delete roles', 'A'],
    ['roles.assign_permissions', 'Assign permissions', 'A'],
    ['roles.remove_permissions', 'Remove permissions', 'A'],
    ['roles.assign_to_employees', 'Assign roles to employees', 'A'],
    ['roles.department_permissions', 'Manage department-level permissions', 'A'],
    ['roles.history', 'View permission history'],
  ],
  departments: [
    ['departments.view', 'View departments'],
    ['departments.create', 'Create departments'],
    ['departments.edit', 'Edit departments', 'S'],
    ['departments.delete', 'Delete departments'],
    ['departments.activate', 'Activate/deactivate departments', 'S'],
    ['departments.managers', 'Assign department managers', 'A'],
    ['departments.manage_staff', 'Assign employees to departments', 'S'],
    ['departments.manage_hours', 'Manage department operating hours', 'S'],
    ['departments.availability', 'Manage department availability', 'S'],
    ['departments.configure_workflow', 'Configure department workflows', 'S'],
    ['departments.performance', 'View department performance', 'S'],
    ['departments.settings', 'Manage department-specific settings', 'S'],
  ],
  menu: [
    ['menu.view', 'View menu', 'S'],
    ['menu.categories', 'Create product categories'],
    ['menu.categories_edit', 'Edit product categories'],
    ['menu.categories_delete', 'Delete product categories'],
    ['menu.create', 'Create products', 'S'],
    ['menu.edit', 'Edit products', 'S'],
    ['menu.delete', 'Delete products', 'S'],
    ['menu.images', 'Upload product images', 'S'],
    ['menu.prices', 'Manage product prices', 'S'],
    ['menu.descriptions', 'Manage product descriptions', 'S'],
    ['menu.variants', 'Manage product variants', 'S'],
    ['menu.addons', 'Manage product add-ons', 'S'],
    ['menu.availability', 'Manage product availability', 'S'],
    ['menu.activate', 'Activate/deactivate products', 'S'],
    ['menu.assign_departments', 'Assign products to departments', 'S'],
    ['menu.featured', 'Manage featured products', 'S'],
    ['menu.promotions', 'Manage discounts and promotions'],
  ],
  orders: [
    ['orders.view', 'View all orders', 'S'],
    ['orders.receive', 'Receive new orders'],
    ['orders.accept', 'Accept orders'],
    ['orders.reject', 'Reject orders'],
    ['orders.cancel', 'Cancel orders'],
    ['orders.edit', 'Edit orders'],
    ['orders.add_items', 'Add items to orders'],
    ['orders.remove_items', 'Remove items from orders'],
    ['orders.quantities', 'Update order quantities'],
    ['orders.details', 'View order details', 'S'],
    ['orders.assign_employees', 'Assign orders to employees'],
    ['orders.assign_departments', 'Assign orders to departments'],
    ['orders.priorities', 'Manage order priorities'],
    ['orders.history', 'View order history'],
    ['orders.refunds', 'Manage order refunds'],
    ['orders.reopen', 'Reopen orders where permitted'],
    ['orders.change_fulfillment', 'Switch an order from dine-in to takeaway'],
  ],
  kitchen: [
    ['kitchen.view_queue', 'View preparation queues', 'S'],
    ['kitchen.accept_tasks', 'Accept preparation tickets', 'S'],
    ['kitchen.start_preparation', 'Start preparation', 'S'],
    ['kitchen.pause', 'Pause preparation', 'S'],
    ['kitchen.update_progress', 'Update preparation progress', 'S'],
    ['kitchen.mark_ready', 'Mark items as ready', 'S'],
    ['kitchen.cancel_tasks', 'Cancel preparation tasks', 'S'],
    ['kitchen.manage_stations', 'Manage preparation stations', 'S'],
    ['kitchen.assign_tasks', 'Assign tasks to employees', 'S'],
    ['kitchen.view_history', 'View preparation history', 'S'],
    ['kitchen.workflows', 'Manage preparation workflows', 'S'],
    ['kitchen.item_handover', 'Manage item handover'],
    ['kitchen.completed', 'Manage completed orders', 'S'],
    ['kitchen.flag_issues', 'Flag delays, unavailable items or ask for help', 'S'],
  ],
  tables: [
    ['tables.view', 'View tables'],
    ['tables.create', 'Create tables'],
    ['tables.edit', 'Edit tables'],
    ['tables.delete', 'Delete tables'],
    ['tables.activate', 'Activate/deactivate tables'],
    ['tables.qr_generate', 'Generate QR codes'],
    ['tables.qr_download', 'Download QR codes'],
    ['tables.qr_print', 'Print QR codes'],
    ['tables.qr_regenerate', 'Regenerate QR codes'],
    ['tables.sessions_view', 'View table sessions'],
    ['tables.assign_orders', 'Assign orders to tables'],
    ['tables.transfer_orders', 'Transfer orders between tables'],
    ['tables.merge', 'Merge tables'],
    ['tables.split_bills', 'Split table bills'],
    ['tables.seat', 'Seat guests and open table sessions'],
    ['tables.waitlist', 'Manage the waiting list'],
    ['tables.transfer_sessions', 'Move guests to another table'],
    ['tables.close_sessions', 'Close table sessions'],
    ['tables.session_override', 'Close sessions with unresolved items (manager)'],
    ['tables.order_history', 'View table order history'],
  ],
  service: [
    ['service.view_ready', 'View ready orders'],
    ['service.view_assigned', 'View assigned orders'],
    ['service.accept_collection', 'Accept collection tasks'],
    ['service.collect', 'Collect prepared items'],
    ['service.serve', 'Mark items as served'],
    ['service.assign_servers', 'Assign orders to servers'],
    ['service.transfer_servers', 'Transfer orders between servers'],
    ['service.table_info', 'View table information'],
    ['service.customer_requests', 'Manage customer requests'],
    ['service.takeaway', 'View takeaway orders'],
    ['orders.handover', 'Manage collection handovers'],
    ['service.dine_in', 'Manage dine-in service'],
    ['service.order_for_guests', 'Take orders for guests at the table'],
    ['service.request_packing', 'Request leftover packing and takeaway'],
  ],
  packing: [
    ['packing.view', 'View packing tasks'],
    ['packing.pack', 'Pack orders and items'],
    ['packing.handover', 'Hand packed food over'],
    ['packing.report_issue', 'Report packing problems'],
  ],
  invoices: [
    ['invoices.view', 'View invoices'],
    ['invoices.generate', 'Create invoices'],
    ['invoices.edit', 'Edit invoices'],
    ['invoices.receipts', 'Generate receipts'],
    ['invoices.print', 'Print invoices'],
    ['invoices.download', 'Download invoices'],
    ['invoices.process_payment', 'Process payments (all kinds)'],
    ['invoices.payment_history', 'View payment history'],
    ['invoices.cash', 'Record cash payments'],
    ['invoices.digital', 'Process digital payments'],
    ['invoices.partial', 'Manage partial payments'],
    ['invoices.split', 'Manage split bills'],
    ['invoices.discounts', 'Apply authorized discounts'],
    ['invoices.refund', 'Process refunds'],
    ['invoices.cancel', 'Cancel invoices'],
    ['invoices.outstanding', 'View outstanding balances'],
    ['invoices.cashier_sessions', 'Close cashier sessions'],
    ['invoices.cashier_reports', 'View cashier reports'],
  ],
  finance: [
    ['finance.revenue', 'View revenue'],
    ['finance.expenses_view', 'View expenses'],
    ['finance.expenses_record', 'Record expenses'],
    ['finance.expenses_edit', 'Edit expenses'],
    ['finance.expenses_delete', 'Delete expenses'],
    ['finance.profit_loss', 'View profit and loss reports'],
    ['finance.department_revenue', 'View department revenue', 'S'],
    ['finance.payment_summaries', 'View payment summaries'],
    ['finance.transactions', 'View financial transactions'],
    ['finance.settings', 'Manage financial settings'],
    ['finance.export', 'Export financial reports'],
  ],
  inventory: [
    ['inventory.view', 'View inventory', 'S'],
    ['inventory.add', 'Add stock', 'S'],
    ['inventory.update', 'Edit stock', 'S'],
    ['inventory.remove', 'Remove stock', 'S'],
    ['inventory.adjust', 'Adjust stock quantities', 'S'],
    ['inventory.movements', 'Track stock movements', 'S'],
    ['inventory.ingredients', 'Manage ingredients', 'S'],
    ['inventory.raw_materials', 'Manage raw materials', 'S'],
    ['inventory.categories', 'Manage stock categories'],
    ['inventory.low_stock_alerts', 'Set low-stock alerts', 'S'],
    ['inventory.view_alerts', 'View stock alerts', 'S'],
    ['inventory.transfers', 'Manage stock transfers between departments'],
    ['inventory.suppliers', 'Manage suppliers'],
    ['inventory.purchase_orders', 'Create purchase orders'],
    ['inventory.receive_deliveries', 'Receive stock deliveries', 'S'],
    ['inventory.waste', 'Record damaged or wasted stock', 'S'],
    ['inventory.reports', 'View inventory reports', 'S'],
  ],
  delivery: [
    ['delivery.view_orders', 'View delivery orders'],
    ['delivery.assign_workers', 'Assign delivery workers'],
    ['delivery.create_assignments', 'Create delivery assignments'],
    ['delivery.change_assignments', 'Change delivery assignments'],
    ['delivery.view_locations', 'View delivery locations'],
    ['delivery.track', 'Track delivery progress'],
    ['delivery.history', 'View delivery history'],
    ['delivery.fees', 'Manage delivery fees'],
    ['delivery.settings', 'Manage delivery settings'],
    ['delivery.confirm_completion', 'Confirm delivery completion'],
    ['delivery.cancel_assignments', 'Cancel delivery assignments'],
    ['delivery.drive', 'Deliver orders as a kitchen courier (own deliveries only)'],
  ],
  customers: [
    ['customers.view', 'View customers'],
    ['customers.profiles', 'View customer profiles'],
    ['customers.order_history', 'View customer order history'],
    ['customers.manage', 'Manage customer information'],
    ['customers.feedback', 'View customer feedback'],
    ['customers.complaints', 'Respond to customer complaints (messages)'],
    ['customers.loyalty', 'Manage customer loyalty points'],
    ['customers.discounts', 'Manage customer discounts'],
    ['customers.reviews', 'View customer reviews'],
  ],
  reservations: [
    ['reservations.view', 'View reservations'],
    ['reservations.confirm', 'Confirm or reject booking requests'],
    ['reservations.check_in', 'Mark arrivals and no-shows, seat booked guests'],
    ['reservations.deposits', 'Record and refund deposits'],
    ['reservations.preorders', 'Manage pre-orders'],
    ['reservations.create', 'Create reservations'],
    ['reservations.edit', 'Edit reservations'],
    ['reservations.cancel', 'Cancel reservations'],
    ['reservations.assign_tables', 'Assign tables to reservations'],
    ['reservations.table_availability', 'Manage table availability'],
    ['reservations.active_sessions', 'View active dining sessions'],
    ['reservations.manage_sessions', 'Manage customer table sessions'],
    ['reservations.extend_close', 'Extend or close sessions'],
  ],
  promotions: [
    ['promotions.view', 'View promotions'],
    ['promotions.create', 'Create promotions'],
    ['promotions.edit', 'Edit promotions'],
    ['promotions.delete', 'Delete promotions'],
    ['promotions.codes', 'Create discount codes'],
    ['promotions.manual_discounts', 'Apply manual discounts'],
    ['promotions.campaigns', 'Configure promotional campaigns'],
    ['promotions.products', 'Manage product-specific discounts'],
    ['promotions.departments', 'Manage department-specific promotions'],
  ],
  notifications: [
    ['notifications.view', 'View notifications'],
    ['notifications.internal', 'Send internal notifications'],
    ['notifications.customer', 'Send customer notifications'],
    ['notifications.preferences', 'Manage notification preferences'],
    ['notifications.history', 'View notification history'],
    ['notifications.order_alerts', 'Manage order alerts'],
    ['notifications.employee_alerts', 'Manage employee alerts'],
  ],
  reports: [
    ['reports.sales', 'View sales reports'],
    ['reports.orders', 'View order reports'],
    ['reports.products', 'View product performance'],
    ['reports.departments', 'View department performance', 'S'],
    ['reports.employees', 'View employee performance'],
    ['reports.inventory', 'View inventory reports', 'S'],
    ['reports.financial', 'View financial reports'],
    ['reports.customers', 'View customer reports'],
    ['reports.payments', 'View payment reports'],
    ['reports.export', 'Export reports'],
    ['reports.historical', 'View historical analytics'],
  ],
  audit: [
    ['audit.kitchen_logs', 'View kitchen activity logs'],
    ['audit.employee_logs', 'View employee activity logs'],
    ['audit.financial_logs', 'View financial activity logs'],
    ['audit.permission_changes', 'View permission changes'],
    ['audit.order_history', 'View order modification history'],
    ['audit.login_history', 'View login history'],
    ['audit.manage_access', 'Manage employee access', 'A'],
    ['audit.revoke_sessions', 'Revoke employee sessions'],
    ['audit.security_events', 'View security events'],
  ],
};

// key -> { group, label, scoped?, owner? (administrators only), planned? }
const PERMISSIONS = {};
for (const [group, entries] of Object.entries(LIST)) {
  for (const [key, label, flags = ''] of entries) {
    PERMISSIONS[key] = { group, label, scoped: flags.includes('S'), owner: flags.includes('A'), planned: flags.includes('P') };
  }
}
// Never shown or put in a role: money leaving the kitchen.
PERMISSIONS['account.wallet'] = { group: null, label: 'Wallet, withdrawals and payout details', owner: true, hidden: true };

const PERMISSION_KEYS = Object.keys(PERMISSIONS);
const SCOPED = new Set(PERMISSION_KEYS.filter((key) => PERMISSIONS[key].scoped));
const ROLE_ASSIGNABLE = PERMISSION_KEYS.filter((key) => !PERMISSIONS[key].owner);

/** What a department manager may do in the departments they manage. */
const DEPARTMENT_MANAGER_PERMISSIONS = [
  'departments.view', 'departments.edit', 'departments.activate', 'departments.manage_staff', 'departments.manage_hours',
  'departments.availability', 'departments.configure_workflow', 'departments.performance', 'departments.settings',
  'kitchen.view_queue', 'kitchen.accept_tasks', 'kitchen.start_preparation', 'kitchen.update_progress', 'kitchen.mark_ready',
  'kitchen.manage_stations', 'kitchen.view_history', 'kitchen.workflows', 'kitchen.completed',
  'menu.view', 'menu.create', 'menu.edit', 'menu.delete', 'menu.images', 'menu.prices', 'menu.descriptions', 'menu.variants',
  'menu.addons', 'menu.availability', 'menu.activate', 'menu.featured',
  'inventory.view', 'inventory.add', 'inventory.update', 'inventory.remove', 'inventory.adjust', 'inventory.movements',
  'inventory.ingredients', 'inventory.raw_materials', 'inventory.low_stock_alerts', 'inventory.view_alerts',
  'inventory.receive_deliveries', 'inventory.waste', 'inventory.reports',
  'reports.departments', 'reports.inventory', 'overview.department_performance', 'finance.department_revenue', 'orders.view', 'kitchen.flag_issues', 'kitchen.pause',
];

const PREP = ['orders.view', 'orders.details', 'departments.view', 'kitchen.view_queue', 'kitchen.accept_tasks', 'kitchen.start_preparation', 'kitchen.update_progress', 'kitchen.mark_ready', 'kitchen.view_history', 'kitchen.pause', 'kitchen.flag_issues', 'menu.view', 'menu.availability', 'inventory.view'];

/**
 * Starting roles every kitchen gets (the administrator edits or deletes them
 * like any other). They have no department: assign the employee to one to limit them.
 */
const DEFAULT_ROLES = [
  {
    key: 'kitchen_manager',
    name: 'Kitchen Manager',
    description: 'Runs the kitchen floor: orders, every preparation queue, the menu and stock.',
    permissions: [
      'overview.dashboard', 'overview.orders', 'overview.pending_orders', 'overview.active_tables', 'overview.active_employees',
      'orders.view', 'orders.receive', 'orders.accept', 'orders.reject', 'orders.cancel', 'orders.details', 'orders.history', 'orders.handover',
      ...PREP, 'kitchen.manage_stations', 'kitchen.item_handover', 'kitchen.completed',
      'service.view_ready', 'service.collect', 'service.serve', 'service.takeaway', 'service.dine_in', 'service.table_info',
      'delivery.view_orders', 'delivery.view_locations', 'delivery.track',
      'menu.edit', 'menu.descriptions', 'menu.activate', 'inventory.update', 'inventory.adjust', 'inventory.view_alerts', 'inventory.reports',
      'tables.view', 'tables.sessions_view', 'reports.orders', 'reports.departments', 'reports.products', 'staff.view',
    ],
  },
  { key: 'chef', name: 'Chef', description: 'Prepares food tickets and can switch dishes off when they run out.', permissions: [...PREP] },
  { key: 'barista', name: 'Barista', description: 'Prepares coffee and drink tickets.', permissions: [...PREP] },
  { key: 'baker', name: 'Baker', description: 'Prepares bakery tickets and manages bakery availability.', permissions: [...PREP] },
  { key: 'bartender', name: 'Bartender', description: 'Prepares bar tickets.', permissions: [...PREP] },
  {
    key: 'server',
    name: 'Server / Waiter',
    description: 'Collects ready items, serves tables and shows customers their bill.',
    permissions: [
      'service.view_assigned', 'service.order_for_guests', 'service.request_packing', 'service.customer_requests', 'tables.sessions_view', 'orders.add_items', 'orders.quantities',
      'orders.view', 'orders.details', 'departments.view', 'service.view_ready', 'service.collect', 'service.serve', 'service.takeaway',
      'service.dine_in', 'service.table_info', 'kitchen.item_handover', 'tables.view', 'tables.sessions_view', 'invoices.view',
      'invoices.print', 'invoices.receipts', 'menu.view',
    ],
  },
  {
    key: 'cashier',
    name: 'Cashier',
    description: 'Creates invoices, takes payments and prints receipts.',
    permissions: [
      'orders.view', 'orders.details', 'orders.handover', 'tables.view', 'tables.close_sessions', 'invoices.view', 'invoices.generate',
      'invoices.receipts', 'invoices.print', 'invoices.download', 'invoices.process_payment', 'invoices.cash', 'invoices.digital',
      'invoices.partial', 'invoices.payment_history', 'invoices.outstanding', 'invoices.cashier_reports',
    ],
  },
  {
    key: 'host',
    name: 'Host / Receptionist',
    description: 'Welcomes guests, seats them, runs the waiting list and the bookings.',
    permissions: [
      'tables.view', 'tables.seat', 'tables.waitlist', 'tables.transfer_sessions', 'tables.sessions_view', 'service.assign_servers', 'service.table_info',
      'reservations.view', 'reservations.create', 'reservations.edit', 'reservations.cancel', 'reservations.confirm', 'reservations.check_in',
      'reservations.assign_tables', 'reservations.table_availability', 'reservations.active_sessions', 'reservations.deposits', 'reservations.preorders',
      'customers.view',
    ],
  },
  {
    key: 'service_supervisor',
    name: 'Service Supervisor',
    description: 'Oversees the floor: tables, servers, sessions and exceptions.',
    permissions: [
      'orders.view', 'orders.details', 'orders.history', 'orders.priorities', 'orders.assign_employees', 'orders.change_fulfillment', 'orders.add_items', 'orders.quantities', 'orders.remove_items',
      'tables.view', 'tables.seat', 'tables.waitlist', 'tables.transfer_sessions', 'tables.transfer_orders', 'tables.close_sessions', 'tables.session_override', 'tables.sessions_view',
      'service.view_ready', 'service.collect', 'service.serve', 'service.dine_in', 'service.takeaway', 'service.assign_servers', 'service.transfer_servers', 'service.customer_requests',
      'service.order_for_guests', 'service.request_packing', 'packing.view', 'invoices.view', 'reservations.view', 'reservations.active_sessions',
    ],
  },
  {
    key: 'packing_staff',
    name: 'Packing Staff',
    description: 'Packs leftovers, takeaway and delivery orders and hands them over.',
    permissions: ['orders.view', 'orders.details', 'packing.view', 'packing.pack', 'packing.handover', 'packing.report_issue', 'service.takeaway'],
  },
  {
    key: 'kitchen_driver',
    name: 'Delivery Driver (kitchen)',
    description: 'Delivers the orders the kitchen brings itself. Sees only their own deliveries.',
    permissions: ['delivery.drive'],
  },
  {
    key: 'stock_manager',
    name: 'Stock Manager',
    description: 'Keeps stock up to date: adds and removes stock, waste, suppliers, purchase orders and transfers.',
    permissions: [
      'inventory.view', 'inventory.add', 'inventory.update', 'inventory.remove', 'inventory.adjust', 'inventory.movements',
      'inventory.ingredients', 'inventory.raw_materials', 'inventory.low_stock_alerts', 'inventory.view_alerts', 'inventory.suppliers',
      'inventory.receive_deliveries', 'inventory.waste', 'inventory.reports', 'reports.inventory', 'menu.view',
      'inventory.purchase_orders', 'inventory.transfers', 'inventory.categories', 'departments.view',
    ],
  },
  {
    key: 'accountant',
    name: 'Accountant',
    description: 'Reads the money side: invoices, payments, refunds and financial reports.',
    permissions: [
      'overview.dashboard', 'overview.statistics', 'overview.sales', 'overview.financial_summary',
      'orders.view', 'orders.history', 'orders.details', 'invoices.view', 'invoices.payment_history', 'invoices.outstanding', 'invoices.refund',
      'finance.revenue', 'finance.department_revenue', 'finance.payment_summaries', 'finance.transactions', 'finance.export',
      'reports.sales', 'reports.orders', 'reports.products', 'reports.departments', 'reports.inventory', 'reports.financial',
      'reports.payments', 'reports.export', 'reports.historical', 'audit.financial_logs',
    ],
  },
  {
    key: 'delivery_coordinator',
    name: 'Delivery Coordinator',
    description: 'Follows delivery and takeaway orders through dispatch and handover.',
    permissions: [
      'orders.view', 'orders.details', 'orders.handover', 'service.view_ready', 'service.collect', 'service.takeaway', 'kitchen.item_handover',
      'delivery.view_orders', 'delivery.view_locations', 'delivery.track', 'delivery.history', 'delivery.confirm_completion',
      'delivery.assign_workers', 'delivery.create_assignments', 'delivery.change_assignments', 'delivery.cancel_assignments', 'packing.view',
    ],
  },
];

/** Suggested service categories; a kitchen may type its own instead. */
/**
 * Which kind of department each preparing role works in. When a kitchen
 * creates a department of that kind, the role is limited to it, so a baker
 * sees bakery tickets and not the whole order. The Kitchen Manager stays
 * kitchen-wide; the Chef cooks for the Kitchen.
 */
const ROLE_DEPARTMENT_CATEGORIES = {
  chef: ['restaurant', 'fast_food', 'catering'],
  baker: ['bakery', 'desserts'],
  barista: ['coffee', 'juice_bar'],
  bartender: ['bar'],
};

const DEPARTMENT_CATEGORIES = [
  { id: 'restaurant', label: 'Restaurant / Food', prefix: 'F' },
  { id: 'coffee', label: 'Coffee / Barista', prefix: 'C' },
  { id: 'bakery', label: 'Bakery', prefix: 'B' },
  { id: 'bar', label: 'Bar / Beverages', prefix: 'D' },
  { id: 'desserts', label: 'Desserts', prefix: 'S' },
  { id: 'fast_food', label: 'Fast Food', prefix: 'Q' },
  { id: 'juice_bar', label: 'Juice & Smoothies', prefix: 'J' },
  { id: 'catering', label: 'Catering', prefix: 'K' },
  { id: 'custom', label: 'Custom service', prefix: 'X' },
];

/**
 * Preparation stages every ticket moves through. A department may skip
 * `accepted` or `preparing` and rename any stage ("Baking", "Ready for
 * collection"), but the stages keep these meanings so an order's overall
 * status can be worked out from its tickets.
 */
const PREP_STAGES = ['pending', 'accepted', 'preparing', 'ready'];
const PREP_STAGE_LABELS = { pending: 'Pending', accepted: 'Accepted', preparing: 'Preparing', ready: 'Ready', cancelled: 'Cancelled' };

/** What happens to an item after it is prepared (separate from preparation). */
const SERVICE_STATUSES = ['pending', 'waiting_collection', 'collected', 'served', 'handed_over', 'cancelled'];
const SERVICE_STATUS_LABELS = {
  pending: 'Being prepared',
  waiting_collection: 'Waiting for collection',
  collected: 'Collected',
  served: 'Served',
  handed_over: 'Handed over',
  cancelled: 'Cancelled',
};

/**
 * When dine-in customers pay. Each choice is enforced at one point:
 *  - 'on_order' / 'before_preparation': departments can't start until the bill is paid,
 *  - 'after_preparation' / 'before_collection': items can't leave the counter until it's paid,
 *  - 'after_service' / 'end_of_session': no gate; the cashier settles the bill at the end.
 * Marketplace orders (delivery and takeaway in the app) are always paid online first.
 */
const PAYMENT_TIMINGS = [
  { id: 'on_order', label: 'When placing the order', gate: 'preparation' },
  { id: 'before_preparation', label: 'Before preparation', gate: 'preparation' },
  { id: 'after_preparation', label: 'After preparation', gate: 'collection' },
  { id: 'before_collection', label: 'Before collection', gate: 'collection' },
  { id: 'after_service', label: 'After receiving the food', gate: 'none' },
  { id: 'end_of_session', label: 'At the end of the table session', gate: 'none' },
];
const PAYMENT_TIMING_IDS = PAYMENT_TIMINGS.map((t) => t.id);
const paymentGate = (timing) => PAYMENT_TIMINGS.find((t) => t.id === timing)?.gate || 'none';

/** Automatic alerts a kitchen can switch on or off (Operations settings), and each person can mute. */
const ALERT_TYPES = [
  { id: 'order_alerts', label: 'Orders: new orders, urgent orders and ready items', setting: 'notifications.order_alerts' },
  { id: 'employee_alerts', label: 'Team: failed sign-ins and late clock-ins', setting: 'notifications.employee_alerts' },
  { id: 'stock', label: 'Low stock', setting: 'settings.notifications' },
  { id: 'requests', label: 'Guests calling the waiter or asking for the bill', setting: 'settings.notifications' },
  { id: 'reservations', label: 'New and changed reservations, arrivals and deposits', setting: 'settings.notifications' },
  { id: 'floor', label: 'Floor: guests seated, servers assigned, bills paid, tables ready to close', setting: 'settings.notifications' },
  { id: 'packing', label: 'Packing: leftovers and takeaway to pack, orders packed', setting: 'settings.notifications' },
  { id: 'deliveries', label: 'Kitchen deliveries: assigned, collected, delivered or failed', setting: 'settings.notifications' },
];

/** Ways a cashier records an in-person payment. */
const IN_PERSON_METHODS = [
  { id: 'cash', label: 'Cash' },
  { id: 'mobile_money', label: 'Mobile Money' },
  { id: 'card', label: 'Card' },
  { id: 'other', label: 'Other' },
];

/** Every permission of a group that can go in a role: anyone holding one may see that area's list. */
const inGroup = (...groupIds) => PERMISSION_KEYS.filter((key) => groupIds.includes(PERMISSIONS[key].group) && !PERMISSIONS[key].owner);

const catalogue = () => ({
  groups: GROUPS.map((group) => ({
    ...group,
    permissions: PERMISSION_KEYS.filter((key) => PERMISSIONS[key].group === group.id).map((key) => ({
      key,
      label: PERMISSIONS[key].label,
      scoped: Boolean(PERMISSIONS[key].scoped),
      // Shown in the list but only kitchen administrators have it (never in a role).
      admin_only: Boolean(PERMISSIONS[key].owner),
      // The feature isn't built yet: it can be put in a role, and allows nothing until then.
      planned: Boolean(PERMISSIONS[key].planned),
    })),
  })),
  department_categories: DEPARTMENT_CATEGORIES,
  prep_stages: PREP_STAGES.map((id) => ({ id, label: PREP_STAGE_LABELS[id] })),
  service_statuses: SERVICE_STATUSES.map((id) => ({ id, label: SERVICE_STATUS_LABELS[id] })),
  payment_timings: PAYMENT_TIMINGS,
  in_person_payment_methods: IN_PERSON_METHODS,
  alert_types: ALERT_TYPES,
  default_roles: DEFAULT_ROLES.map(({ key, name, description }) => ({ key, name, description })),
});

module.exports = {
  GROUPS,
  PERMISSIONS,
  PERMISSION_KEYS,
  inGroup,
  SCOPED,
  ROLE_ASSIGNABLE,
  DEPARTMENT_MANAGER_PERMISSIONS,
  DEFAULT_ROLES,
  DEPARTMENT_CATEGORIES,
  ROLE_DEPARTMENT_CATEGORIES,
  PREP_STAGES,
  PREP_STAGE_LABELS,
  SERVICE_STATUSES,
  SERVICE_STATUS_LABELS,
  PAYMENT_TIMINGS,
  PAYMENT_TIMING_IDS,
  IN_PERSON_METHODS,
  ALERT_TYPES,
  paymentGate,
  catalogue,
};
