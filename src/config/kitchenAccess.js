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
  { id: 'orders', label: 'Orders' },
  { id: 'departments', label: 'Services & Departments' },
  { id: 'kitchen', label: 'Kitchen Operations' },
  { id: 'service', label: 'Service & Collection' },
  { id: 'staff', label: 'Staff Management' },
  { id: 'tables', label: 'Tables & QR Codes' },
  { id: 'invoices', label: 'Invoices & Payments' },
  { id: 'inventory', label: 'Inventory' },
  { id: 'menu', label: 'Menu & Products' },
  { id: 'reports', label: 'Reports' },
  { id: 'kitchen_account', label: 'Kitchen account' },
];

// key -> { group, label, scoped? , owner? }
const PERMISSIONS = {
  'orders.view': { group: 'orders', label: 'View orders' },
  'orders.receive': { group: 'orders', label: 'Receive new orders' },
  'orders.accept': { group: 'orders', label: 'Accept or reject orders' },
  'orders.update_status': { group: 'orders', label: 'Update order status' },
  'orders.cancel': { group: 'orders', label: 'Cancel orders' },
  'orders.assign': { group: 'orders', label: 'Assign orders to employees' },
  'orders.history': { group: 'orders', label: 'View order history' },
  'orders.handover': { group: 'orders', label: 'Confirm pickup and kitchen-delivery codes' },

  'departments.view': { group: 'departments', label: 'View departments' },
  'departments.create': { group: 'departments', label: 'Create departments' },
  'departments.edit': { group: 'departments', label: 'Edit departments', scoped: true },
  'departments.delete': { group: 'departments', label: 'Delete departments' },
  'departments.manage_staff': { group: 'departments', label: 'Manage department employees', scoped: true },
  'departments.manage_hours': { group: 'departments', label: 'Manage department operating hours', scoped: true },
  'departments.configure_workflow': { group: 'departments', label: 'Configure preparation workflows', scoped: true },

  'kitchen.view_queue': { group: 'kitchen', label: 'View preparation queues', scoped: true },
  'kitchen.accept_tasks': { group: 'kitchen', label: 'Accept preparation tasks', scoped: true },
  'kitchen.start_preparation': { group: 'kitchen', label: 'Start preparation', scoped: true },
  'kitchen.mark_ready': { group: 'kitchen', label: 'Mark items as ready', scoped: true },
  'kitchen.manage_stations': { group: 'kitchen', label: 'Manage preparation stations', scoped: true },
  'kitchen.view_history': { group: 'kitchen', label: 'View preparation history', scoped: true },

  'service.view_ready': { group: 'service', label: 'View ready items and collection tasks' },
  'service.collect': { group: 'service', label: 'Collect prepared items' },
  'service.serve': { group: 'service', label: 'Mark items as served' },
  'service.delivery_handover': { group: 'service', label: 'View delivery handover details' },

  'staff.view': { group: 'staff', label: 'View employees' },
  'staff.create': { group: 'staff', label: 'Create employee accounts' },
  'staff.edit': { group: 'staff', label: 'Edit employee accounts' },
  'staff.assign_roles': { group: 'staff', label: 'Assign roles' },
  'staff.manage_permissions': { group: 'staff', label: 'Create and edit roles and permissions' },
  'staff.deactivate': { group: 'staff', label: 'Deactivate accounts' },

  'tables.view': { group: 'tables', label: 'View tables' },
  'tables.create': { group: 'tables', label: 'Create tables' },
  'tables.edit': { group: 'tables', label: 'Edit tables' },
  'tables.delete': { group: 'tables', label: 'Delete tables' },
  'tables.qr': { group: 'tables', label: 'Generate, download and print QR codes' },
  'tables.assign': { group: 'tables', label: 'Manage table assignments and sessions' },

  'invoices.view': { group: 'invoices', label: 'View invoices' },
  'invoices.generate': { group: 'invoices', label: 'Generate invoices' },
  'invoices.edit': { group: 'invoices', label: 'Edit invoices where permitted' },
  'invoices.process_payment': { group: 'invoices', label: 'Process payments' },
  'invoices.payment_history': { group: 'invoices', label: 'View payment history' },
  'invoices.refund': { group: 'invoices', label: 'Manage refunds' },

  'inventory.view': { group: 'inventory', label: 'View stock', scoped: true },
  'inventory.add': { group: 'inventory', label: 'Add stock items', scoped: true },
  'inventory.update': { group: 'inventory', label: 'Update stock', scoped: true },
  'inventory.remove': { group: 'inventory', label: 'Remove stock', scoped: true },
  'inventory.suppliers': { group: 'inventory', label: 'Manage suppliers' },
  'inventory.reports': { group: 'inventory', label: 'View inventory reports', scoped: true },

  'menu.view': { group: 'menu', label: 'View products', scoped: true },
  'menu.create': { group: 'menu', label: 'Create products', scoped: true },
  'menu.edit': { group: 'menu', label: 'Edit products', scoped: true },
  'menu.delete': { group: 'menu', label: 'Delete products', scoped: true },
  'menu.prices': { group: 'menu', label: 'Manage prices', scoped: true },
  'menu.availability': { group: 'menu', label: 'Manage product availability', scoped: true },
  'menu.categories': { group: 'menu', label: 'Manage product categories' },

  'reports.sales': { group: 'reports', label: 'View sales reports (whole kitchen)' },
  'reports.orders': { group: 'reports', label: 'View order reports' },
  'reports.inventory': { group: 'reports', label: 'View inventory reports', scoped: true },
  'reports.departments': { group: 'reports', label: 'View department reports', scoped: true },
  'reports.staff': { group: 'reports', label: 'View employee performance' },
  'reports.activity': { group: 'reports', label: 'View the activity log' },

  // Only kitchen administrators: money leaving the kitchen and the account itself.
  'account.wallet': { group: 'kitchen_account', label: 'Wallet, withdrawals and payout details', owner: true },
  'account.settings': { group: 'kitchen_account', label: 'Kitchen profile, opening the store and settings', owner: true },
  'account.messages': { group: 'kitchen_account', label: 'Customer messages, support and special deliveries' },
  'account.notifications': { group: 'kitchen_account', label: "Read the kitchen's notifications" },
};

const PERMISSION_KEYS = Object.keys(PERMISSIONS);
const SCOPED = new Set(PERMISSION_KEYS.filter((key) => PERMISSIONS[key].scoped));
const ROLE_ASSIGNABLE = PERMISSION_KEYS.filter((key) => !PERMISSIONS[key].owner);

/** What a department manager may do in the departments they manage. */
const DEPARTMENT_MANAGER_PERMISSIONS = [
  'departments.view',
  'departments.edit',
  'departments.manage_staff',
  'departments.manage_hours',
  'departments.configure_workflow',
  'kitchen.view_queue',
  'kitchen.accept_tasks',
  'kitchen.start_preparation',
  'kitchen.mark_ready',
  'kitchen.manage_stations',
  'kitchen.view_history',
  'menu.view',
  'menu.create',
  'menu.edit',
  'menu.delete',
  'menu.prices',
  'menu.availability',
  'inventory.view',
  'inventory.add',
  'inventory.update',
  'inventory.remove',
  'inventory.reports',
  'reports.departments',
  'reports.inventory',
  'orders.view',
];

const PREP = ['kitchen.view_queue', 'kitchen.accept_tasks', 'kitchen.start_preparation', 'kitchen.mark_ready', 'kitchen.view_history'];

/**
 * Starting roles every kitchen gets (editable and deletable like any other).
 * They have no department: assign the employee to a department to limit them.
 */
const DEFAULT_ROLES = [
  {
    key: 'kitchen_manager',
    name: 'Kitchen Manager',
    description: 'Runs the kitchen floor: orders, every preparation queue, the menu and stock.',
    permissions: [
      'orders.view', 'orders.receive', 'orders.accept', 'orders.update_status', 'orders.cancel', 'orders.assign', 'orders.history', 'orders.handover',
      'departments.view', ...PREP, 'kitchen.manage_stations',
      'service.view_ready', 'service.collect', 'service.serve', 'service.delivery_handover',
      'menu.view', 'menu.edit', 'menu.availability', 'inventory.view', 'inventory.update', 'inventory.reports',
      'tables.view', 'reports.orders', 'reports.departments', 'staff.view',
    ],
  },
  {
    key: 'chef',
    name: 'Chef',
    description: 'Prepares food tickets and can switch dishes off when they run out.',
    permissions: ['orders.view', 'departments.view', ...PREP, 'menu.view', 'menu.availability', 'inventory.view'],
  },
  {
    key: 'barista',
    name: 'Barista',
    description: 'Prepares coffee and drink tickets.',
    permissions: ['orders.view', 'departments.view', ...PREP, 'menu.view', 'menu.availability', 'inventory.view'],
  },
  {
    key: 'baker',
    name: 'Baker',
    description: 'Prepares bakery tickets and manages bakery availability.',
    permissions: ['orders.view', 'departments.view', ...PREP, 'menu.view', 'menu.availability', 'inventory.view'],
  },
  {
    key: 'bartender',
    name: 'Bartender',
    description: 'Prepares bar tickets.',
    permissions: ['orders.view', 'departments.view', ...PREP, 'menu.view', 'menu.availability', 'inventory.view'],
  },
  {
    key: 'server',
    name: 'Server / Waiter',
    description: 'Collects ready items, serves tables and shows customers their bill.',
    permissions: [
      'orders.view', 'departments.view', 'service.view_ready', 'service.collect', 'service.serve', 'service.delivery_handover',
      'tables.view', 'tables.assign', 'invoices.view', 'menu.view',
    ],
  },
  {
    key: 'cashier',
    name: 'Cashier',
    description: 'Generates invoices, takes payments and prints receipts.',
    permissions: [
      'orders.view', 'orders.handover', 'tables.view', 'invoices.view', 'invoices.generate', 'invoices.process_payment', 'invoices.payment_history',
    ],
  },
  {
    key: 'stock_manager',
    name: 'Stock Manager',
    description: 'Keeps stock levels, suppliers and stock movements up to date.',
    permissions: [
      'inventory.view', 'inventory.add', 'inventory.update', 'inventory.remove', 'inventory.suppliers', 'inventory.reports', 'reports.inventory', 'menu.view',
    ],
  },
  {
    key: 'accountant',
    name: 'Accountant',
    description: 'Reads the money side: invoices, payments, refunds and sales reports.',
    permissions: [
      'orders.view', 'orders.history', 'invoices.view', 'invoices.payment_history', 'invoices.refund',
      'reports.sales', 'reports.orders', 'reports.departments', 'reports.inventory', 'reports.staff',
    ],
  },
  {
    key: 'delivery_coordinator',
    name: 'Delivery Coordinator',
    description: 'Follows delivery and takeaway orders through dispatch and handover.',
    permissions: ['orders.view', 'orders.update_status', 'orders.handover', 'service.view_ready', 'service.collect', 'service.delivery_handover'],
  },
];

/** Suggested service categories; a kitchen may type its own instead. */
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

/** Ways a cashier records an in-person payment. */
const IN_PERSON_METHODS = [
  { id: 'cash', label: 'Cash' },
  { id: 'mobile_money', label: 'Mobile Money' },
  { id: 'card', label: 'Card' },
  { id: 'other', label: 'Other' },
];

const catalogue = () => ({
  groups: GROUPS.map((group) => ({
    ...group,
    permissions: PERMISSION_KEYS.filter((key) => PERMISSIONS[key].group === group.id).map((key) => ({
      key,
      label: PERMISSIONS[key].label,
      scoped: Boolean(PERMISSIONS[key].scoped),
      admin_only: Boolean(PERMISSIONS[key].owner),
    })),
  })),
  department_categories: DEPARTMENT_CATEGORIES,
  prep_stages: PREP_STAGES.map((id) => ({ id, label: PREP_STAGE_LABELS[id] })),
  service_statuses: SERVICE_STATUSES.map((id) => ({ id, label: SERVICE_STATUS_LABELS[id] })),
  payment_timings: PAYMENT_TIMINGS,
  in_person_payment_methods: IN_PERSON_METHODS,
  default_roles: DEFAULT_ROLES.map(({ key, name, description }) => ({ key, name, description })),
});

module.exports = {
  GROUPS,
  PERMISSIONS,
  PERMISSION_KEYS,
  SCOPED,
  ROLE_ASSIGNABLE,
  DEPARTMENT_MANAGER_PERMISSIONS,
  DEFAULT_ROLES,
  DEPARTMENT_CATEGORIES,
  PREP_STAGES,
  PREP_STAGE_LABELS,
  SERVICE_STATUSES,
  SERVICE_STATUS_LABELS,
  PAYMENT_TIMINGS,
  PAYMENT_TIMING_IDS,
  IN_PERSON_METHODS,
  paymentGate,
  catalogue,
};
