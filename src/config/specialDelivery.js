/**
 * Special delivery negotiation (big events): request and quotation states.
 *
 * TRANSITIONS[from][to] lists who may make that change. Anything not listed
 * is refused by services/specialDeliveryTransitions.js; the client never sets
 * a status directly, it calls an action (accept, decline, submit quotation…).
 */
const REQUEST_STATUSES = [
  'pending_vendor_review',
  'negotiation_accepted',
  'awaiting_customer_information',
  'negotiating',
  'quotation_submitted',
  'quotation_revision_requested',
  'quotation_accepted',
  'quotation_rejected',
  'vendor_declined',
  'customer_cancelled',
  'quotation_expired',
  'delivery_confirmed',
  'completed',
  'disputed',
];

const C = 'customer';
const V = 'vendor';
const S = 'system';
const A = 'admin';

// While the price is still being worked out.
const OPEN_NEGOTIATION = {
  quotation_submitted: [V],
  vendor_declined: [V],
  customer_cancelled: [C],
};

const TRANSITIONS = {
  pending_vendor_review: {
    negotiation_accepted: [V],
    awaiting_customer_information: [V],
    vendor_declined: [V],
    customer_cancelled: [C],
  },
  awaiting_customer_information: {
    // The customer answered the kitchen's question.
    pending_vendor_review: [C],
    negotiation_accepted: [V],
    vendor_declined: [V],
    customer_cancelled: [C],
  },
  negotiation_accepted: { negotiating: [C, V, S], ...OPEN_NEGOTIATION },
  negotiating: { ...OPEN_NEGOTIATION },
  quotation_submitted: {
    // A revised quotation replaces the open one (the old one is superseded).
    quotation_submitted: [V],
    quotation_accepted: [C],
    quotation_revision_requested: [C],
    quotation_rejected: [C],
    quotation_expired: [S],
    // The kitchen withdrew its quotation and keeps talking.
    negotiating: [V],
    vendor_declined: [V],
    customer_cancelled: [C],
  },
  quotation_revision_requested: { negotiating: [C, V, S], ...OPEN_NEGOTIATION },
  quotation_rejected: { negotiating: [C, V, S], ...OPEN_NEGOTIATION },
  quotation_expired: { negotiating: [C, V, S], ...OPEN_NEGOTIATION },
  quotation_accepted: {
    // The event order with the agreed price was paid.
    delivery_confirmed: [S],
    customer_cancelled: [C, S],
    disputed: [C, V],
  },
  delivery_confirmed: {
    completed: [S, A],
    customer_cancelled: [S, A],
    disputed: [C, V],
  },
  disputed: { completed: [A], customer_cancelled: [A], delivery_confirmed: [A] },
  vendor_declined: {},
  customer_cancelled: {},
  completed: {},
};

// No longer open: frees the customer to start a new request with the kitchen.
const CLOSED_STATUSES = ['vendor_declined', 'customer_cancelled', 'completed'];
// The kitchen may submit (or revise) a quotation from these.
const QUOTABLE_STATUSES = Object.keys(TRANSITIONS).filter((from) => TRANSITIONS[from].quotation_submitted);
// The chat is open (both sides may write) in these.
const CHAT_OPEN_STATUSES = REQUEST_STATUSES.filter(
  (status) => !['pending_vendor_review', ...CLOSED_STATUSES].includes(status)
);

const STATUS_LABELS = {
  pending_vendor_review: 'Waiting for the kitchen',
  negotiation_accepted: 'Kitchen is open to discuss',
  awaiting_customer_information: 'Kitchen needs more information',
  negotiating: 'Discussing the delivery',
  quotation_submitted: 'Quotation received',
  quotation_revision_requested: 'New price requested',
  quotation_accepted: 'Price agreed',
  quotation_rejected: 'Quotation rejected',
  vendor_declined: 'Declined by the kitchen',
  customer_cancelled: 'Cancelled',
  quotation_expired: 'Quotation expired',
  delivery_confirmed: 'Delivery confirmed',
  completed: 'Completed',
  disputed: 'In dispute',
};

const QUOTATION_STATUSES = ['draft', 'submitted', 'accepted', 'rejected', 'withdrawn', 'superseded', 'expired'];

const QUOTATION_TRANSITIONS = {
  draft: { submitted: [V] },
  submitted: { accepted: [C], rejected: [C], withdrawn: [V, S], superseded: [V], expired: [S] },
  accepted: {},
  rejected: {},
  withdrawn: {},
  superseded: {},
  expired: {},
};

const ARRANGEMENTS = [
  { code: 'own_vehicle', label: 'Kitchen-owned vehicle' },
  { code: 'rented_vehicle', label: 'Rented vehicle' },
  { code: 'third_party', label: 'Third-party transport' },
  { code: 'multiple_trips', label: 'Multiple vehicles or trips' },
  { code: 'other', label: 'Other arrangement' },
];

const TRIGGER_MESSAGES = {
  outside_coverage: "This destination is outside the kitchen's delivery coverage.",
  above_ceiling: 'The delivery fee for this distance is above the automatic pricing limit.',
  route_unavailable: "We couldn't measure the road distance to this destination.",
  automatic_pricing_off: 'Automatic big-event delivery pricing is switched off, so the kitchen quotes the delivery.',
};

const CUSTOMER_MESSAGE =
  'This delivery destination requires a special delivery arrangement. You can request special delivery and discuss the delivery fee with the vendor before confirming your order.';

module.exports = {
  REQUEST_STATUSES,
  TRANSITIONS,
  CLOSED_STATUSES,
  QUOTABLE_STATUSES,
  CHAT_OPEN_STATUSES,
  STATUS_LABELS,
  QUOTATION_STATUSES,
  QUOTATION_TRANSITIONS,
  ARRANGEMENTS,
  TRIGGER_MESSAGES,
  CUSTOMER_MESSAGE,
};
