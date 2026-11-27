const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { parseObjectId } = require('../../utils/vendorValidators');
const { Order, Vendor } = require('../../models');
const alerts = require('./alertService');
const activity = require('./activityService');

/**
 * What the kitchen tells a customer about their order, and the customer's
 * answer. A department that runs late or can't make a dish flags its ticket
 * (ticketService.flag); this turns it into a plain message on the customer's
 * order page, with choices when a dish is missing:
 *
 *  - ordered at the table (paid at the restaurant): remove it, or remove it
 *    and choose something else. The bill goes down by that dish.
 *  - paid in the app: continue without it (its price is refunded), or cancel
 *    the order (full refund).
 *
 * The department and the table's server hear the answer. If every remaining
 * dish is missing, the only choice is cancelling the order.
 */
const CHOICE_LABELS = { remove: 'Continue without it', swap: 'Choose something else', cancel: 'Cancel the order' };
const live = (order) => (order.items || []).filter((i) => i.service_status !== 'cancelled');
const missing = (order, issue) => {
  const ids = new Set((issue.item_ids || []).map(String));
  return live(order).filter((i) => ids.has(String(i._id)));
};
const atRestaurant = (order) => order.payment_method === 'in_person';

/** What the customer may answer now (none once answered, or for a delay). */
function choicesFor(order, issue) {
  if (issue.status !== 'open' || ['cancelled', 'delivered'].includes(order.status)) return [];
  const gone = missing(order, issue);
  if (!gone.length) return [];
  const keepsSomething = live(order).length > gone.length;
  if (atRestaurant(order)) {
    if (order.payment_status === 'paid') return [];
    return keepsSomething ? ['remove', 'swap'] : ['swap', 'cancel'];
  }
  // Paid in the app: the dish's price can go back while the money is held.
  const canRefundPart = order.payment_status === 'paid' && order.settlement_status === 'held' && !issue.refund_blocked;
  return [...(keepsSomething && canRefundPart ? ['remove'] : []), 'cancel'];
}

/** The messages for the customer's order page (delays drop once that dish is ready). */
function serialize(order) {
  const tickets = new Map((order.tickets || []).map((t) => [String(t._id), t]));
  const items = new Map((order.items || []).map((i) => [String(i._id), i]));
  return (order.customer_issues || [])
    .filter((issue) => {
      if (issue.kind !== 'delayed') return true;
      const ticket = tickets.get(String(issue.ticket_id));
      return ticket && ['pending', 'accepted', 'preparing'].includes(ticket.status);
    })
    .map((issue) => {
      const names = (issue.item_ids || []).map((id) => items.get(String(id))).filter(Boolean).map((i) => `${i.quantity}× ${i.name}`);
      const where = issue.department_name || 'The kitchen';
      const message =
        issue.kind === 'delayed'
          ? `${where} is running ${issue.minutes ? `about ${issue.minutes} minutes ` : ''}late.`
          : `Sorry, we can't make ${names.join(', ') || 'a dish'} today.`;
      return {
        id: String(issue._id),
        kind: issue.kind,
        message,
        note: issue.note || '',
        items: names,
        minutes: issue.minutes ?? null,
        status: issue.status,
        choice: issue.choice || null,
        choice_label: issue.choice ? CHOICE_LABELS[issue.choice] : null,
        refund_rwf: issue.refund_rwf || 0,
        choices: choicesFor(order, issue).map((id) => ({ id, label: CHOICE_LABELS[id] })),
        created_at: issue.created_at,
        answered_at: issue.answered_at || null,
      };
    });
}

class CustomerIssueService {
  /** Called when a department flags its ticket: tells the customer. */
  async fromFlag(order, ticket, { kind, itemIds = [], minutes = null, note = '' }) {
    if (!['delayed', 'unavailable'].includes(kind)) return;
    const issue = {
      _id: new mongoose.Types.ObjectId(),
      kind,
      ticket_id: ticket._id,
      department_name: ticket.department_name || '',
      item_ids: itemIds,
      minutes,
      note,
      status: kind === 'delayed' ? 'info' : 'open',
      created_at: new Date(),
    };
    await Order.updateOne({ _id: order._id }, { $push: { customer_issues: { $each: [issue], $slice: -20 } } });
    if (!order.customer_id) return; // a guest at a table sees it on the table page
    const fresh = await Order.findById(order._id).lean();
    const view = serialize(fresh).find((i) => i.id === String(issue._id));
    require('../notificationService')
      .notifyCustomerOrder(order.customer_id, {
        orderId: order._id,
        orderNumber: order.order_number,
        title: kind === 'delayed' ? `${order.order_number} is running late` : `${order.order_number}: a dish isn't available`,
        body: kind === 'delayed' ? view?.message || '' : `${view?.message || ''} Open your order to choose what to do.`,
      })
      .catch(() => null);
  }

  serialize(order) {
    return serialize(order);
  }

  /**
   * The customer's answer. `who`: { customerId } for an app customer (checked
   * by the caller), or { guest: true } for a guest whose key was checked.
   */
  async respond(order, issueId, rawChoice, who = {}) {
    const id = parseObjectId(issueId, 'issue_id');
    const issue = (order.customer_issues || []).find((i) => String(i._id) === String(id));
    if (!issue) throw ApiError.notFound('That message was not found.', 'ISSUE_NOT_FOUND');
    const choice = String(rawChoice || '');
    const allowed = choicesFor(order, issue);
    if (!allowed.includes(choice)) {
      throw ApiError.conflict(issue.status === 'answered' ? 'You already answered this.' : "That choice isn't possible for this order any more.", 'ISSUE_CHOICE_UNAVAILABLE');
    }
    const vendor = await Vendor.findById(order.vendor_id);
    const actor = { type: 'customer', id: order.customer_id ? String(order.customer_id) : null, name: order.guest?.name || 'Customer' };
    const gone = missing(order, issue);
    let refund = 0;

    if (choice === 'cancel') {
      if (atRestaurant(order)) {
        await require('../vendorOrderService').applyStatus(vendor, order, 'cancelled', { note: 'The guest cancelled: a dish was not available', actor });
      } else {
        await require('../orderService').cancel(who.customerId || order.customer_id, order._id, { reason: 'A dish was not available' });
      }
    } else if (atRestaurant(order)) {
      await this.#removeAtRestaurant(vendor, order, gone, actor);
    } else {
      refund = await this.#removeAndRefund(vendor, order, gone);
      if (refund === null) {
        await Order.updateOne({ _id: order._id, 'customer_issues._id': id }, { $set: { 'customer_issues.$.refund_blocked': true } });
        throw ApiError.conflict('Part of this order was already refunded. Cancel the order, or contact support.', 'ISSUE_CHOICE_UNAVAILABLE');
      }
    }

    const now = new Date();
    await Order.updateOne(
      { _id: order._id, 'customer_issues._id': id },
      { $set: { 'customer_issues.$.status': 'answered', 'customer_issues.$.choice': choice, 'customer_issues.$.answered_at': now, 'customer_issues.$.refund_rwf': refund } }
    );
    // The department's flag is sorted out: the customer decided.
    const ticketIndex = (order.tickets || []).findIndex((t) => String(t._id) === String(issue.ticket_id));
    const flagIndex = ticketIndex >= 0 ? (order.tickets[ticketIndex].flags || []).findIndex((f) => f.kind === 'unavailable' && !f.resolved_at) : -1;
    if (flagIndex >= 0) {
      await Order.updateOne({ _id: order._id }, { $set: { [`tickets.${ticketIndex}.flags.${flagIndex}.resolved_at`]: now } });
    }

    const where = order.table?.label || order.order_number;
    const names = gone.map((i) => i.name).join(', ');
    const title = `${where}: ${choice === 'cancel' ? 'order cancelled' : choice === 'swap' ? `${names} removed, choosing something else` : `continue without ${names}`}`;
    const body = choice === 'cancel' ? `The customer cancelled because ${names} isn't available.` : refund ? `${refund.toLocaleString('en-US')} RWF goes back to the customer.` : 'The bill was lowered.';
    alerts.emit(order.vendor_id, 'order_alerts', { title, body, link: order.table ? '/vendor-dashboard/service' : '/vendor-dashboard/orders', permission: 'service.view_assigned' });
    if (issue.ticket_id) alerts.emit(order.vendor_id, 'order_alerts', { title, body, link: '/vendor-dashboard/kitchen', permission: 'kitchen.view_queue', admins: false });
    activity.recordSystem(order.vendor_id, { action: 'order.customer_answer', target_type: 'order', target_id: order._id, summary: `${order.order_number}: ${CHOICE_LABELS[choice]} (${names})` }, actor);

    return Order.findById(order._id).lean();
  }

  /** Paid at the restaurant: the dishes come off the order and its bill. */
  async #removeAtRestaurant(vendor, order, gone, actor) {
    const ids = new Set(gone.map((i) => String(i._id)));
    const items = order.items.map((i) => (ids.has(String(i._id)) ? { ...i, service_status: 'cancelled' } : i));
    if (!items.some((i) => i.service_status !== 'cancelled')) {
      await require('../vendorOrderService').applyStatus(vendor, order, 'cancelled', { note: 'The guest removed the dishes the kitchen could not make', actor });
      return;
    }
    const tickets = order.tickets.map((t) =>
      items.some((i) => String(i.ticket_id) === String(t._id) && i.service_status !== 'cancelled') ? t : { ...t, status: 'cancelled', cancelled_at: new Date(), cancel_reason: 'Dish not available' }
    );
    const subtotal = items.filter((i) => i.service_status !== 'cancelled').reduce((sum, i) => sum + i.subtotal_rwf, 0);
    const saved = await Order.findOneAndUpdate(
      { _id: order._id, updated_at: order.updated_at, payment_status: { $ne: 'paid' } },
      {
        $set: { items, tickets, subtotal_rwf: subtotal, total_rwf: subtotal + (order.delivery_fee_rwf || 0) },
        $push: { status_history: { status: order.status, at: new Date(), note: `The guest removed ${gone.map((i) => i.name).join(', ')} (not available)` } },
      },
      { returnDocument: 'after' }
    ).lean();
    if (!saved) throw ApiError.conflict('This order just changed. Refresh and try again.', 'ORDER_CHANGED');
    await require('./invoiceService').syncOrderLines(order._id);
    await require('./ticketService').syncParent(vendor, saved);
  }

  /**
   * Paid in the app: the dishes come off, the held total and the kitchen's
   * payout go down by their price, and that amount is refunded. Returns the
   * refund, or null when this order's dish refund was already sent.
   */
  async #removeAndRefund(vendor, order, gone) {
    const amount = gone.reduce((sum, i) => sum + (i.subtotal_rwf || 0), 0);
    const refundService = require('../refundService');
    const { Refund } = require('../../models');
    const sent = await Refund.exists({ order_id: order._id, kind: 'item_unavailable', status: { $ne: 'pending' } });
    if (sent) return null;
    const settlementService = require('../settlementService');
    const ids = new Set(gone.map((i) => String(i._id)));
    const items = order.items.map((i) => (ids.has(String(i._id)) ? { ...i, service_status: 'cancelled' } : i));
    const tickets = order.tickets.map((t) =>
      items.some((i) => String(i.ticket_id) === String(t._id) && i.service_status !== 'cancelled') ? t : { ...t, status: 'cancelled', cancelled_at: new Date(), cancel_reason: 'Dish not available' }
    );
    const subtotal = Math.max(0, (order.subtotal_rwf || 0) - amount);
    const split = settlementService.splitForPercent({ ...order, subtotal_rwf: subtotal }, order.commission_percent || 0);
    const saved = await Order.findOneAndUpdate(
      { _id: order._id, settlement_status: 'held', updated_at: order.updated_at },
      {
        $set: {
          items,
          tickets,
          subtotal_rwf: subtotal,
          total_rwf: Math.max(0, (order.total_rwf || 0) - amount),
          // What the customer actually paid stays known, so a later cancel refunds the rest only.
          amount_paid_rwf: order.amount_paid_rwf ?? order.total_rwf,
          commission_rwf: split.commissionRwf,
          vendor_payout_rwf: split.vendorPayout,
        },
        $push: { status_history: { status: order.status, at: new Date(), note: `The customer continued without ${gone.map((i) => i.name).join(', ')} (not available): ${amount} RWF refunded` } },
      },
      { returnDocument: 'after' }
    ).lean();
    if (!saved) throw ApiError.conflict('This order just changed. Refresh and try again.', 'ORDER_CHANGED');
    await refundService.openItemRefund(saved, { amountRwf: amount, reason: `${gone.map((i) => i.name).join(', ')} not available` });
    await require('./invoiceService').syncOrderLines(order._id).catch(() => null);
    await require('./ticketService').syncParent(vendor, saved);
    return amount;
  }
}

module.exports = new CustomerIssueService();
module.exports.serialize = serialize;
