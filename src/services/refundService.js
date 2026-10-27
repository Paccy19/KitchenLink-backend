const config = require('../config');
const ApiError = require('../utils/ApiError');
const { parseAdminListQuery, parseEnum, parseOptionalText, parseObjectId } = require('../utils/adminValidators');
const refundRepository = require('../repositories/refundRepository');
const orderRepository = require('../repositories/orderRepository');
const paymentRepository = require('../repositories/paymentRepository');
const transactionRepository = require('../repositories/transactionRepository');
const notificationService = require('./notificationService');
const adminActionLogService = require('./adminActionLogService');
const adminAuthService = require('./adminAuthService');
const { activeProvider } = require('./payoutProviders');

const MOBILE_MONEY_PHONE = /^0(78|79|73|72)\d{7}$/;
const REFUND_STATUSES = ['pending', 'completed', 'failed'];

const formatRwf = (amount) => `${Number(amount || 0).toLocaleString('en-US')} RWF`;

const networkOf = (phone = '') => (/^07[89]/.test(phone) ? 'MTN MoMo' : /^07[23]/.test(phone) ? 'Airtel Money' : 'Mobile money');

const destinationLabel = (destination = {}) =>
  destination.type === 'card'
    ? `card ending ${destination.card_last4 || '····'}`
    : `${networkOf(destination.phone)} ${destination.phone || ''}`.trim();

const normalizePhone = (raw) => {
  let digits = String(raw ?? '').replace(/[^\d]/g, '');
  if (digits.startsWith('250')) digits = digits.slice(3);
  if (!digits.startsWith('0')) digits = `0${digits}`;
  return digits;
};

const STATUS_LABELS = {
  pending: 'Refund in progress',
  completed: 'Refunded',
  failed: 'Refund failed',
};

const serializeRefund = (refund, { admin = false } = {}) => {
  if (!refund) return null;
  const out = {
    id: String(refund._id),
    order_id: String(refund.order_id?._id || refund.order_id),
    order_number: refund.order_number || '',
    amount_rwf: refund.amount_rwf,
    status: refund.status,
    status_label: STATUS_LABELS[refund.status] || refund.status,
    payment_method: refund.payment_method,
    destination: {
      type: refund.destination?.type || 'mobile_money',
      phone: refund.destination?.phone || '',
      card_last4: refund.destination?.card_last4 || '',
      label: destinationLabel(refund.destination),
    },
    cancelled_by: refund.cancelled_by,
    reason: refund.reason || '',
    reference: refund.reference || '',
    failure_reason: refund.failure_reason || '',
    // The customer may give another mobile money number until it is sent.
    can_change_destination: refund.status !== 'completed',
    expected_within_hours: config.refunds.expectedWithinHours,
    created_at: refund.created_at,
    completed_at: refund.completed_at,
    failed_at: refund.failed_at,
  };
  if (admin) {
    const customer = refund.customer_id && typeof refund.customer_id === 'object' && refund.customer_id.name ? refund.customer_id : null;
    const vendor = refund.vendor_id && typeof refund.vendor_id === 'object' && refund.vendor_id.name ? refund.vendor_id : null;
    out.customer = customer ? { id: String(customer._id), name: customer.name, phone: customer.phone_number } : null;
    out.vendor = vendor ? { id: String(vendor._id), name: vendor.name } : null;
    out.provider = refund.provider;
    out.attempts = refund.attempts || 0;
  }
  return out;
};

/**
 * Refunds for paid orders that were cancelled. Opened automatically by the
 * settlement step when a held order is cancelled (by the customer, kitchen,
 * support, or a kitchen suspension); the money goes back the way the customer
 * paid. With a manual payout service an admin sends it and records the
 * transaction reference; an automatic service sends it immediately.
 */
class RefundService {
  /** Called once per cancelled paid order (after the held money is claimed). */
  async open(order, { by = 'system', reason = '' } = {}) {
    const details = order.payment_details || {};
    const isCard = order.payment_method === 'card';
    const refund = await refundRepository.createOnce({
      order_id: order._id,
      order_number: order.order_number || '',
      customer_id: order.customer_id,
      vendor_id: order.vendor_id || null,
      // Two-part orders give back what was paid so far (maybe only the deposit).
      amount_rwf: Math.round(Number(order.amount_paid_rwf ?? order.total_rwf) || 0),
      payment_method: order.payment_method || '',
      destination: isCard
        ? { type: 'card', card_last4: String(details.card_number || '').slice(-4) }
        : { type: 'mobile_money', phone: details.phone || '' },
      cancelled_by: by,
      reason: String(reason || '').slice(0, 200),
      provider: config.admin.owner.payoutProvider || 'manual',
    });
    if (!refund || refund.status !== 'pending') return refund;

    const sent = await this.#tryAutomatic(refund);
    if (sent) return sent;

    notificationService
      .notifyAdmin({
        type: 'refund_update',
        title: 'Refund to send',
        body: `${formatRwf(refund.amount_rwf)} for cancelled order ${refund.order_number} goes back to ${destinationLabel(refund.destination)}.`,
        orderId: refund.order_id,
        link: `/admin-dashboard/refunds?refund=${refund._id}`,
      })
      .catch(() => null);
    return refund;
  }

  /** With an automatic payout service, send it straight away. */
  async #tryAutomatic(refund) {
    const provider = activeProvider();
    const destination = { type: 'mobile_money', account_number: refund.destination.phone };
    if (!provider.automatic || refund.destination.type !== 'mobile_money' || !provider.supports(destination)) return null;
    const result = await provider
      .send({ amountRwf: refund.amount_rwf, destination, reference: `refund-${refund._id}` })
      .catch((error) => ({ status: 'failed', error: error?.message || 'payout service error' }));
    if (result.status === 'sent') return this.#complete(refund, { reference: result.providerReference });
    if (result.status === 'failed') return this.#fail(refund, { reason: `Payout service: ${result.error}` });
    return null;
  }

  async #complete(refund, { reference, admin = null }) {
    const done = await refundRepository.transition(refund._id, ['pending'], {
      status: 'completed',
      reference,
      completed_at: new Date(),
      processed_by: admin?._id || null,
      failure_reason: '',
      $inc: { attempts: 1 },
    });
    if (!done) {
      throw ApiError.conflict('This refund was just updated by someone else.', 'REFUND_CHANGED');
    }
    // The cash leaves the platform account now.
    await transactionRepository.create({
      type: 'refund',
      direction: 'debit',
      status: 'refunded',
      amount_rwf: done.amount_rwf,
      order_id: done.order_id,
      customer_id: done.customer_id,
      reference: reference || done.order_number || '',
      description: `Refund for ${done.order_number} sent to ${destinationLabel(done.destination)}`,
      metadata: { refund_id: String(done._id) },
    });
    await orderRepository.update(done.order_id, { payment_status: 'refunded' });
    const payment = await paymentRepository.findLatestByOrder(done.order_id);
    if (payment && payment.status === 'successful') await paymentRepository.update(payment._id, { status: 'refunded' });

    this.#notifyCustomer(done, 'Refund sent', `${formatRwf(done.amount_rwf)} for ${done.order_number} was sent back to your ${destinationLabel(done.destination)}${reference ? ` (ref ${reference})` : ''}.`);
    return done;
  }

  async #fail(refund, { reason, admin = null }) {
    const failed = await refundRepository.transition(refund._id, ['pending'], {
      status: 'failed',
      failure_reason: reason,
      failed_at: new Date(),
      processed_by: admin?._id || null,
      $inc: { attempts: 1 },
    });
    if (!failed) {
      throw ApiError.conflict('This refund was just updated by someone else.', 'REFUND_CHANGED');
    }
    this.#notifyCustomer(
      failed,
      'Refund could not be sent',
      `We could not send ${formatRwf(failed.amount_rwf)} for ${failed.order_number} to ${destinationLabel(failed.destination)}${reason ? ` (${reason})` : ''}. Open the order to give another mobile money number.`
    );
    return failed;
  }

  #notifyCustomer(refund, title, body) {
    notificationService
      .notifyCustomerOrder(refund.customer_id, { orderId: refund.order_id, orderNumber: refund.order_number, title, body, type: 'refund_update' })
      .catch(() => null);
  }

  /* ------------------------------ customers ------------------------------ */

  async forOrder(orderId) {
    return serializeRefund(await refundRepository.findByOrder(orderId));
  }

  async listForCustomer(customerId) {
    const refunds = await refundRepository.listByCustomer(customerId);
    return { refunds: refunds.map((refund) => serializeRefund(refund)) };
  }

  /** The customer gives the mobile money number to send the refund to. */
  async changeDestination(customerId, orderId, body = {}) {
    parseObjectId(orderId, 'order_id');
    const refund = await refundRepository.findForCustomer(customerId, orderId);
    if (!refund) throw ApiError.notFound('This order has no refund.', 'REFUND_NOT_FOUND');
    if (refund.status === 'completed') {
      throw ApiError.conflict('This refund was already sent.', 'REFUND_COMPLETED');
    }
    const phone = normalizePhone(body.phone);
    if (!MOBILE_MONEY_PHONE.test(phone)) {
      throw ApiError.badRequest('Enter a valid MTN or Airtel mobile money number.', {
        phone: 'expected a number like 0788123456',
      });
    }
    const updated = await refundRepository.transition(refund._id, ['pending', 'failed'], {
      status: 'pending',
      destination: { type: 'mobile_money', phone, card_last4: '' },
      failure_reason: '',
    });
    if (!updated) throw ApiError.conflict('This refund was already sent.', 'REFUND_COMPLETED');

    const sent = await this.#tryAutomatic(updated);
    if (!sent) {
      notificationService
        .notifyAdmin({
          type: 'refund_update',
          title: refund.status === 'failed' ? 'Refund ready to retry' : 'Refund number changed',
          body: `The customer wants ${formatRwf(updated.amount_rwf)} for ${updated.order_number} sent to ${destinationLabel(updated.destination)}.`,
          orderId: updated.order_id,
          link: `/admin-dashboard/refunds?refund=${updated._id}`,
        })
        .catch(() => null);
    }
    return { refund: serializeRefund(sent || updated) };
  }

  /* -------------------------------- admins -------------------------------- */

  async adminList(query = {}) {
    const { limit, page, offset } = parseAdminListQuery(query, {
      defaultLimit: config.admin.limits.listDefault,
      maxLimit: config.admin.limits.listMax,
    });
    const status = parseEnum(query.status, REFUND_STATUSES, 'status');
    const search = typeof query.search === 'string' ? query.search.trim().slice(0, 60) : '';
    const [{ refunds, total }, totals] = await Promise.all([
      refundRepository.adminList({ status, search, limit, offset }),
      refundRepository.totals(),
    ]);
    return {
      items: refunds.map((refund) => serializeRefund(refund, { admin: true })),
      total,
      page,
      limit,
      summary: totals,
      payout_service: { automatic: Boolean(activeProvider().automatic), label: activeProvider().label },
    };
  }

  /**
   * Admin decision on a refund:
   *  - completed: the money was sent back (reference required)
   *  - failed:    it could not be sent (reason); the customer is asked for
   *               another number. Still owed.
   *  - pending:   retry a failed refund
   */
  async adminUpdate(refundId, { status, reference, reason, action_code } = {}, admin, req) {
    parseObjectId(refundId, 'refund_id');
    const next = parseEnum(status, REFUND_STATUSES, 'status');
    if (!next) {
      throw ApiError.badRequest('status is required.', { status: `expected one of: ${REFUND_STATUSES.join(', ')}` });
    }
    const refund = await refundRepository.findById(refundId);
    if (!refund) throw ApiError.notFound('Refund not found.', 'REFUND_NOT_FOUND');
    if (refund.status === 'completed') {
      throw ApiError.conflict('This refund was already sent and cannot be changed.', 'REFUND_COMPLETED');
    }

    let updated;
    if (next === 'completed') {
      if (refund.status !== 'pending') {
        throw ApiError.conflict('Retry the refund before marking it sent.', 'REFUND_NOT_PENDING');
      }
      const cleanReference = parseOptionalText(reference, { field: 'reference', max: 120 }) || '';
      if (!cleanReference) {
        throw ApiError.badRequest('Enter the transaction reference of the money you sent back.', {
          reference: 'required (e.g. the MoMo transaction id)',
        });
      }
      await adminAuthService.confirmLargeMoney(admin, refund.amount_rwf, action_code);
      updated = await this.#complete(refund, { reference: cleanReference, admin });
    } else if (next === 'failed') {
      if (refund.status !== 'pending') {
        throw ApiError.conflict('This refund is already marked failed.', 'REFUND_NOT_PENDING');
      }
      const cleanReason = parseOptionalText(reason, { field: 'reason', max: 200 }) || '';
      if (!cleanReason) {
        throw ApiError.badRequest('Say why the refund could not be sent.', { reason: 'required' });
      }
      updated = await this.#fail(refund, { reason: cleanReason, admin });
    } else {
      if (refund.status !== 'failed') {
        throw ApiError.conflict('Only a failed refund can be retried.', 'REFUND_NOT_FAILED');
      }
      updated = await refundRepository.transition(refund._id, ['failed'], { status: 'pending', failure_reason: '' });
      if (!updated) throw ApiError.conflict('This refund was just updated by someone else.', 'REFUND_CHANGED');
    }

    await adminActionLogService.record(
      admin,
      {
        action: `refund.${next}`,
        target_type: 'refund',
        target_id: refundId,
        target_label: refund.order_number,
        metadata: { amount_rwf: refund.amount_rwf, reference: updated.reference || undefined, reason: updated.failure_reason || undefined },
      },
      req
    );
    return { refund: serializeRefund(updated, { admin: true }) };
  }
}

module.exports = new RefundService();
module.exports.serializeRefund = serializeRefund;
