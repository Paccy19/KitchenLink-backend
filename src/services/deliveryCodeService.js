const crypto = require('crypto');
const config = require('../config');
const ApiError = require('../utils/ApiError');
const { Delivery, Customer, Order } = require('../models');
const { hashOtp } = require('../utils/otpHash');
const { sendEmail, escapeHtml } = require('../utils/email');
const { sendSms } = require('../utils/sms');
const { maskEmail, maskPhone } = require('../utils/identifier');

const CLOSED = ['completed', 'cancelled', 'rejected', 'failed'];
const RESEND_GAP_SECONDS = 60;
const MAX_SENDS = 5;
const validHours = () => Number(config.delivery.codeValidHours) || 12;

/** Bound to one delivery: the same digits for another order never match. */
const hashFor = (deliveryId, code) => hashOtp(`delivery:${deliveryId}:${code}`);

const smsReady = () => {
  const { sms } = config.notifications;
  return Boolean(sms.enabled && sms.apiUrl && sms.apiKey);
};

/**
 * The code a customer gives the delivery worker once the food is in their
 * hands. Completely separate from sign-in codes (its own records, rules and
 * hashing).
 *
 *  - Issued when the food is ready (or, at the latest, when the rider sets
 *    off); one code per delivery, stored only as a hash bound to that
 *    delivery; valid DELIVERY_CODE_VALID_HOURS (12 h).
 *  - Sent only to the customer: their verified email, or SMS once a gateway
 *    is connected. Never in an API response, the customer's or worker's
 *    screens, notifications or logs (a development server may print it to
 *    its own console when it could not be sent, so the flow can be tried).
 *  - No channel (no verified email, no SMS gateway): the code still exists,
 *    nothing is skipped; the customer is told to verify an email and ask for
 *    the code again, the worker is told to call support, and support can
 *    complete the delivery from the admin panel after checking.
 *  - The worker's tries are counted per delivery (5, then it locks); the
 *    customer may ask for a new code (60 s apart, 5 a delivery), which
 *    replaces the old one.
 */
class DeliveryCodeService {
  /** Where the customer's code goes: { channel: 'email'|'sms'|'none', to, sentTo }. */
  #channelFor(customer) {
    if (customer?.email && customer.email_verified_at) return { channel: 'email', to: customer.email, sentTo: maskEmail(customer.email) };
    if (customer?.phone_number && smsReady()) return { channel: 'sms', to: customer.phone_number, sentTo: maskPhone(customer.phone_number) };
    return { channel: 'none', to: null, sentTo: '' };
  }

  /**
   * A new code for this delivery, sent to the customer. `onlyIfMissing`: only
   * when none was issued yet (several requests at once still issue one).
   * Returns { channel, sent_to } (never the code), or null when nothing was issued.
   */
  async issue(deliveryId, { onlyIfMissing = false, expectIssuedAt } = {}) {
    const code = String(crypto.randomInt(100000, 1000000));
    const now = new Date();
    const filter = { _id: deliveryId, status: { $nin: CLOSED }, otp_verified_at: null };
    if (onlyIfMissing) filter.$and = [{ $or: [{ otp_code_hash: { $in: ['', null] } }, { otp_code_hash: { $exists: false } }] }];
    if (expectIssuedAt !== undefined) filter.otp_issued_at = expectIssuedAt;
    const claimed = await Delivery.findOneAndUpdate(
      filter,
      {
        $set: {
          otp_code_hash: hashFor(deliveryId, code),
          otp_code: '',
          otp_issued_at: now,
          otp_expires_at: new Date(now.getTime() + validHours() * 3600 * 1000),
        },
        $inc: { otp_send_count: 1 },
      },
      { returnDocument: 'after' }
    ).lean();
    if (!claimed) return null;

    const customer = await Customer.findById(claimed.customer_id).lean();
    let target = this.#channelFor(customer);
    const sent = await this.#send(target, claimed, code);
    if (!sent && target.channel === 'email' && customer?.phone_number && smsReady()) {
      // The email didn't leave: the same code by SMS instead.
      target = { channel: 'sms', to: customer.phone_number, sentTo: maskPhone(customer.phone_number) };
      if (!(await this.#send(target, claimed, code))) target = { channel: 'none', to: null, sentTo: '' };
    } else if (!sent) {
      target = { channel: 'none', to: null, sentTo: '' };
    }
    await Delivery.updateOne({ _id: claimed._id, otp_issued_at: now }, { $set: { otp_channel: target.channel, otp_sent_to: target.sentTo } });

    if (target.channel === 'none') {
      console.warn(`[delivery] ${claimed.order_number}: the customer has no verified email or SMS: their delivery code could not be sent`);
      if (config.explicitDev) console.log(`[delivery code] ${claimed.order_number} -> ${code} (development server only: not sent to anyone)`);
    }
    await this.#notify(claimed, target);
    return { channel: target.channel, sent_to: target.sentTo };
  }

  async #send({ channel, to }, delivery, code) {
    if (channel === 'none') return false;
    const ref = delivery.order_number ? `order ${delivery.order_number}` : 'your order';
    const hours = validHours();
    if (channel === 'sms') {
      const result = await sendSms(to, `KitchenLink delivery code for ${ref}: ${code}. Give it to the delivery worker only after you receive your food. Valid ${hours} h.`);
      return result.status === 'sent';
    }
    const result = await sendEmail({
      to,
      sensitive: true,
      subject: `Your KitchenLink delivery code for ${ref}`,
      text: `Your delivery confirmation code for ${ref} is ${code}.\n\nGive it to the delivery worker only after you have received your food: it confirms the delivery. It works for ${hours} hours. KitchenLink staff will never ask for it.`,
      html: `<p>Your delivery confirmation code for <strong>${escapeHtml(ref)}</strong> is</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p><p style="color:#666">Give it to the delivery worker only after you have received your food: it confirms the delivery. It works for ${hours} hours. KitchenLink staff will never ask for it.</p>`,
    });
    return result.status === 'sent';
  }

  async #notify(delivery, target, { reminder = false } = {}) {
    // Required here: notificationService is loaded by many services.
    // eslint-disable-next-line global-require
    const notificationService = require('./notificationService');
    await notificationService
      .notifyDeliveryCodeSent(delivery.customer_id, {
        orderNumber: delivery.order_number,
        orderId: delivery.order_id,
        channel: target.channel,
        sentTo: target.sentTo,
        reminder,
      })
      .catch((error) => console.log(`[delivery] could not notify the customer about their code: ${error?.message}`));
  }

  /** The food is ready / the rider set off: a code if there is none yet (older deliveries included). */
  async issueIfMissing(delivery) {
    if (!delivery || delivery.otp_verified_at || CLOSED.includes(delivery.status) || delivery.otp_code_hash) return null;
    return this.issue(delivery._id, { onlyIfMissing: true });
  }

  /** The rider is on the way: a reminder (no code in it), or the code if none was issued. */
  async remind(delivery) {
    if (!delivery?.otp_code_hash) return this.issueIfMissing(delivery);
    const fresh = await Delivery.findById(delivery._id).lean();
    await this.#notify(fresh, { channel: fresh.otp_channel || 'none', sentTo: fresh.otp_sent_to || '' }, { reminder: true });
    return null;
  }

  /** The customer asks for a new code (lost it, expired, or just verified an email). */
  async resend(customerId, orderId) {
    const order = await Order.findOne({ _id: orderId, customer_id: customerId }, { delivery_id: 1, order_number: 1 }).lean();
    if (!order) throw ApiError.notFound('Order not found.', 'ORDER_NOT_FOUND');
    const delivery = order.delivery_id ? await Delivery.findById(order.delivery_id).lean() : null;
    if (!delivery || CLOSED.includes(delivery.status) || delivery.otp_verified_at) {
      throw ApiError.conflict('This order has no delivery waiting for a code.', 'NO_DELIVERY_CODE');
    }
    if (!delivery.otp_code_hash && !delivery.otp_code && !delivery.ready_at && delivery.status === 'pending') {
      throw ApiError.conflict('Your delivery code is sent when the kitchen has your food ready.', 'DELIVERY_NOT_READY');
    }
    if ((delivery.otp_attempts || 0) >= config.auth.otpMaxAttempts) {
      throw ApiError.conflict('Too many wrong codes were entered for this delivery. Contact support to complete it.', 'DELIVERY_CODE_LOCKED');
    }
    if ((delivery.otp_send_count || 0) >= MAX_SENDS) {
      throw ApiError.tooMany('You have asked for this code too many times. Contact support.', 'DELIVERY_CODE_RESEND_LIMIT');
    }
    const customer = await Customer.findById(customerId).lean();
    if (this.#channelFor(customer).channel === 'none') {
      throw ApiError.conflict(
        'We can only send your delivery code to a verified email address. Add and verify your email in your profile, then ask again.',
        'NO_DELIVERY_CODE_CHANNEL'
      );
    }
    if (delivery.otp_issued_at && Date.now() - new Date(delivery.otp_issued_at).getTime() < RESEND_GAP_SECONDS * 1000) {
      throw ApiError.tooMany('A code was just sent. Please wait a minute before asking again.', 'OTP_RESEND_TOO_SOON', { retry_after_seconds: RESEND_GAP_SECONDS });
    }
    // Only if nobody else re-issued it meanwhile.
    const issued = await this.issue(delivery._id, { expectIssuedAt: delivery.otp_issued_at ?? null });
    if (!issued) throw ApiError.tooMany('A code was just sent. Please wait a minute before asking again.', 'OTP_RESEND_TOO_SOON');
    return { sent: issued.channel !== 'none', ...issued };
  }

  /**
   * The worker's try. Counted atomically per delivery (5, then locked: only
   * support can complete it). Throws unless it is this delivery's current,
   * unexpired code. A code from before hashing (plaintext) still works.
   */
  async check(delivery, rawCode) {
    if (!delivery.otp_code_hash && !delivery.otp_code) {
      throw ApiError.conflict(
        "The customer hasn't been sent a delivery code yet. Ask them to open the order and tap \"Send my delivery code\", or contact support.",
        'DELIVERY_CODE_NOT_ISSUED'
      );
    }
    if ((delivery.otp_attempts || 0) >= config.auth.otpMaxAttempts) {
      throw ApiError.tooMany('Too many wrong delivery codes for this order. Contact support to complete it.', 'DELIVERY_CODE_LOCKED');
    }
    if (delivery.otp_expires_at && new Date(delivery.otp_expires_at) < new Date()) {
      throw new ApiError(400, 'DELIVERY_CODE_EXPIRED', 'This delivery code has expired. Ask the customer to tap "Send my delivery code" for a new one.');
    }
    const maxTries = config.auth.otpMaxAttempts;
    const claimed = await Delivery.findOneAndUpdate(
      { _id: delivery._id, otp_attempts: { $lt: maxTries } },
      { $inc: { otp_attempts: 1 } },
      { returnDocument: 'after' }
    ).lean();
    if (!claimed) {
      throw ApiError.tooMany('Too many wrong delivery codes for this order. Contact support to complete it.', 'DELIVERY_CODE_LOCKED');
    }
    if (!this.#matches(claimed, rawCode)) {
      const left = Math.max(maxTries - claimed.otp_attempts, 0);
      throw new ApiError(
        400,
        'OTP_INVALID',
        left > 0
          ? `Incorrect delivery code. ${left} attempt${left === 1 ? '' : 's'} left.`
          : 'Incorrect delivery code. This delivery is now locked; contact support to complete it.',
        { otp_code: 'incorrect code', attempts_remaining: left }
      );
    }
    return true;
  }

  #matches(delivery, rawCode) {
    const code = String(rawCode ?? '');
    if (delivery.otp_code_hash) {
      const expected = Buffer.from(delivery.otp_code_hash, 'hex');
      const given = Buffer.from(hashFor(delivery._id, code), 'hex');
      return expected.length === given.length && crypto.timingSafeEqual(expected, given);
    }
    return typeof delivery.otp_code === 'string' && delivery.otp_code.length === code.length &&
      crypto.timingSafeEqual(Buffer.from(delivery.otp_code), Buffer.from(code));
  }

  /** What the customer's order screen may show about the code (never the code). */
  describe(delivery) {
    if (!delivery) return {};
    const issued = Boolean(delivery.otp_code_hash || delivery.otp_code);
    return {
      code_issued: issued,
      code_sent_via: issued ? delivery.otp_channel || (delivery.otp_code ? 'in_app' : 'none') : null,
      code_sent_to: issued ? delivery.otp_sent_to || '' : '',
      code_expires_at: issued ? delivery.otp_expires_at || null : null,
      code_needs_channel: issued && delivery.otp_channel === 'none',
    };
  }
}

module.exports = new DeliveryCodeService();
module.exports.RESEND_GAP_SECONDS = RESEND_GAP_SECONDS;
module.exports.MAX_SENDS = MAX_SENDS;
