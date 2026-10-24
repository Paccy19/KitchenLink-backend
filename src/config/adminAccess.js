/**
 * Who can do what in the admin panel.
 *
 * Every admin operation belongs to a category and needs one permission.
 * A team member's role decides their permissions (nothing else does): an
 * operation that is not in their role is refused. The owner (`super_admin`)
 * can do everything, including the owner-only operations no role can get.
 */

const CATEGORIES = [
  { id: 'overview', label: 'Overview', description: 'Dashboard totals and the alerts feed.' },
  { id: 'operations', label: 'Operations', description: 'Orders, deliveries, kitchens, delivery workers, customers and the menu categories.' },
  { id: 'support', label: 'Support', description: 'Conversations with customers, vendors and delivery workers, and complaints.' },
  { id: 'finance', label: 'Finance', description: 'Payments, payouts to vendors and delivery workers, refunds and the platform books.' },
  { id: 'reports', label: 'Reports', description: 'Analytics.' },
  { id: 'owner', label: 'Owner only', description: 'Commission rate, the owner\'s money, the audit log and the team. Never given to a role.' },
];

// permission -> { category, label }
const PERMISSIONS = {
  'dashboard:read': { category: 'overview', label: 'See the dashboard overview' },

  'orders:read': { category: 'operations', label: 'See orders' },
  'orders:write': { category: 'operations', label: 'Change order status, cancel orders, reassign delivery workers' },
  'deliveries:read': { category: 'operations', label: 'See live deliveries' },
  'deliveries:write': { category: 'operations', label: 'Set delivery & pickup rules, delivery timing and delivery fees by distance' },
  'vendors:read': { category: 'operations', label: 'See vendors and applications' },
  'vendors:write': { category: 'operations', label: 'Approve, reject or suspend vendors' },
  'drivers:read': { category: 'operations', label: 'See delivery workers' },
  'drivers:write': { category: 'operations', label: 'Approve, reject or suspend delivery workers' },
  'users:read': { category: 'operations', label: 'See customers' },
  'users:write': { category: 'operations', label: 'Block or unblock customers' },
  'categories:read': { category: 'operations', label: 'See food categories' },
  'categories:write': { category: 'operations', label: 'Add, edit, delete or reorder food categories' },

  'complaints:read': { category: 'support', label: 'Read support conversations and complaints' },
  'complaints:write': { category: 'support', label: 'Reply, resolve, set priority, write internal notes' },
  'chats:read': { category: 'support', label: 'Read customer–kitchen chats (read only)' },

  'payments:read': { category: 'finance', label: 'See customer payments' },
  'commissions:read': { category: 'finance', label: 'See the commission settings' },
  'payouts:read': { category: 'finance', label: 'See withdrawal requests and balances' },
  'payouts:write': { category: 'finance', label: 'Pay out or fail vendor and delivery worker withdrawals' },
  'refunds:read': { category: 'finance', label: 'See refunds' },
  'refunds:write': { category: 'finance', label: 'Send, fail or retry refunds' },
  'wallet:read': { category: 'finance', label: 'See the platform wallet and the books' },

  'analytics:read': { category: 'reports', label: 'See analytics' },

  'commissions:write': { category: 'owner', label: 'Change the commission rate' },
  'actions:read': { category: 'owner', label: 'See the audit log' },
  'team:manage': { category: 'owner', label: 'Invite, change or remove team members' },
};

const ROLES = {
  support_agent: {
    label: 'Support Agent',
    description:
      'Answers customers, vendors and delivery workers. Can look up orders, deliveries, people and refund status, but changes nothing except support conversations.',
    permissions: [
      'orders:read',
      'deliveries:read',
      'vendors:read',
      'drivers:read',
      'users:read',
      'refunds:read',
      'complaints:read',
      'complaints:write',
      'chats:read',
    ],
  },
  operations_manager: {
    label: 'Operations Manager',
    description:
      'Runs day-to-day work: orders and cancellations, delivery workers, approving or suspending kitchens and workers, customers, food categories and support. No money powers.',
    permissions: [
      'dashboard:read',
      'orders:read',
      'orders:write',
      'deliveries:read',
      'deliveries:write',
      'vendors:read',
      'vendors:write',
      'drivers:read',
      'drivers:write',
      'users:read',
      'users:write',
      'categories:read',
      'categories:write',
      'complaints:read',
      'complaints:write',
      'chats:read',
    ],
  },
  finance_officer: {
    label: 'Finance Officer',
    description:
      'Handles money going out: pays vendor and delivery worker withdrawals, sends refunds, sees payments and the books. Cannot cancel orders, approve kitchens or change the commission rate.',
    permissions: [
      'dashboard:read',
      'orders:read',
      'payments:read',
      'commissions:read',
      'payouts:read',
      'payouts:write',
      'refunds:read',
      'refunds:write',
      'wallet:read',
      'analytics:read',
    ],
  },
  analyst: {
    label: 'Analyst',
    description: 'Read-only: dashboard, analytics, orders, kitchens, delivery workers and payments.',
    permissions: ['dashboard:read', 'orders:read', 'vendors:read', 'drivers:read', 'payments:read', 'analytics:read'],
  },
};

// Roles created before the team existed.
const LEGACY_ROLES = { support: 'support_agent', operations: 'operations_manager', finance: 'finance_officer' };

const OWNER_ROLE = 'super_admin';
const TEAM_ROLES = Object.keys(ROLES);
const ALL_PERMISSIONS = Object.keys(PERMISSIONS);

const roleKey = (role) => LEGACY_ROLES[role] || role;

/** The permissions an admin actually has (the owner has all of them). */
const permissionsFor = (admin) => {
  if (!admin) return [];
  if (admin.role === OWNER_ROLE) return ALL_PERMISSIONS;
  return ROLES[roleKey(admin.role)]?.permissions || [];
};

const can = (admin, permission) => permissionsFor(admin).includes(permission);

const roleLabel = (role) => (role === OWNER_ROLE ? 'Owner' : ROLES[roleKey(role)]?.label || role);

// Which alerts each permission may see in the shared admin feed.
const NOTIFICATION_PERMISSION = {
  vendor_application: 'vendors:read',
  // A kitchen asked to change its vendor type.
  vendor_type_request: 'vendors:read',
  category_added: 'categories:read',
  driver_application: 'drivers:read',
  complaint_opened: 'complaints:read',
  payout_requested: 'payouts:read',
  payout_update: 'payouts:read',
  refund_update: 'refunds:read',
  order_placed: 'orders:read',
  late_pickup: 'deliveries:read',
  payment_failed: 'payments:read',
  owner_finance: 'team:manage',
};

/** Notification types this admin may see in the feed. */
const visibleNotificationTypes = (admin) => {
  const owned = permissionsFor(admin);
  return Object.entries(NOTIFICATION_PERMISSION)
    .filter(([, permission]) => owned.includes(permission))
    .map(([type]) => type)
    .concat('general');
};

/** The catalogue sent to the admin panel (team page, invite form). */
const describe = () => ({
  categories: CATEGORIES,
  permissions: Object.entries(PERMISSIONS).map(([id, meta]) => ({ id, ...meta })),
  roles: Object.entries(ROLES).map(([id, role]) => ({ id, ...role })),
});

module.exports = {
  CATEGORIES,
  PERMISSIONS,
  ROLES,
  LEGACY_ROLES,
  OWNER_ROLE,
  TEAM_ROLES,
  ALL_PERMISSIONS,
  permissionsFor,
  can,
  roleKey,
  roleLabel,
  visibleNotificationTypes,
  describe,
};
