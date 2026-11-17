const crypto = require('crypto');
const mongoose = require('mongoose');
const config = require('../config');
const refundRepository = require('../repositories/refundRepository');
const ApiError = require('../utils/ApiError');
const { parseObjectId, parseAdminListQuery } = require('../utils/adminValidators');
const { parseDeliveryLocation, parseScheduledFor } = require('../utils/validators');
const { buildPublicUrl } = require('../utils/uploads');
const { SpecialDeliveryRequest, DeliveryQuotation, ChatConversation, Counter, Customer, Vendor, Order } = require('../models');
const vendorRepository = require('../repositories/vendorRepository');
const chatRepository = require('../repositories/chatRepository');
const notificationService = require('./notificationService');
const bigEventDeliveryService = require('./bigEventDeliveryService');
const bigEventDeliverySettingsService = require('./bigEventDeliverySettingsService');
const { serializeMessage, parseBody, PRIVACY_NOTE } = require('./chatService');
const { transitionRequest, transitionQuotation, allowedNext } = require('./specialDeliveryTransitions');
const { EVENT_ORDER, eventPackageFor, serializeEventOffer } = require('../config/eventPackages');
const { districtByCode } = require('../config/rwandaDistricts');
const {
  STATUS_LABELS,
  QUOTABLE_STATUSES,
  CHAT_OPEN_STATUSES,
  ARRANGEMENTS,
  TRIGGER_MESSAGES,
} = require('../config/specialDelivery');

const MAX_FEE_RWF = 10000000;
const TEXT_MAX = 1000;
const EXPIRY_SWEEP_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const CUSTOMER = (customer) => ({ role: 'customer', id: customer._id });
const VENDOR = (vendor) => ({ role: 'vendor', id: vendor._id });
const SYSTEM = { role: 'system', id: null };
const ADMIN = (admin) => ({ role: 'admin', id: admin?._id ?? null });

const sid = (value) => (value ? String(value._id ?? value) : null);
const rwf = (amount) => `${Number(amount).toLocaleString('en-US')} RWF`;

function text(raw, field, { max = TEXT_MAX, required = false, label = field } = {}) {
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    throw ApiError.badRequest(`${label} must be text.`, { [field]: 'expected text' });
  }
  const value = (raw || '').trim();
  if (required && !value) throw ApiError.badRequest(`${label} is required.`, { [field]: 'required' });
  if (value.length > max) throw ApiError.badRequest(`${label} can be at most ${max} characters.`, { [field]: `max ${max}` });
  return value;
}

function futureDate(raw, field, label) {
  const date = new Date(raw);
  if (raw === undefined || raw === null || raw === '' || Number.isNaN(date.getTime())) {
    throw ApiError.badRequest(`${label} must be a date and time.`, { [field]: 'expected an ISO date' });
  }
  if (date.getTime() <= Date.now()) throw ApiError.badRequest(`${label} must be in the future.`, { [field]: 'expected a future date' });
  return date;
}

/* ------------------------------ serializing ------------------------------ */

const arrangementLabel = (code) => ARRANGEMENTS.find((a) => a.code === code)?.label ?? code;

function serializeQuotation(q) {
  if (!q) return null;
  return {
    id: String(q._id),
    reference: q.reference,
    version: q.version,
    status: q.status,
    fee_rwf: q.fee_rwf,
    destination: q.destination,
    proposed_delivery_at: q.proposed_delivery_at,
    arrangements: (q.arrangements || []).map((code) => ({ code, label: arrangementLabel(code) })),
    arrangement_description: q.arrangement_description || '',
    conditions: q.conditions || '',
    valid_until: q.valid_until,
    expired: q.status === 'submitted' && new Date(q.valid_until) <= new Date(),
    submitted_at: q.submitted_at,
    decided_at: q.decided_at ?? null,
    decision_note: q.decision_note || '',
    status_history: q.status_history || [],
  };
}

function serializeRequest(request, side, { vendor = null, customer = null, quotations = null, conversation = null } = {}) {
  const role = side === 'admin' ? 'admin' : side;
  const district = request.destination_district ? districtByCode(request.destination_district) : null;
  const open = quotations?.find((q) => q.status === 'submitted') ?? null;
  const unread = conversation
    ? side === 'customer'
      ? conversation.unread_by_customer
      : side === 'vendor'
        ? conversation.unread_by_vendor
        : 0
    : 0;
  return {
    id: String(request._id),
    reference: request.reference,
    status: request.status,
    status_label: STATUS_LABELS[request.status] || request.status,
    is_active: request.is_active,
    vendor: vendor
      ? { id: sid(vendor), name: vendor.name, avatar_url: vendor.profile_image_url || null, phone: side === 'admin' ? vendor.phone || '' : undefined }
      : { id: sid(request.vendor_id) },
    customer: customer
      ? { id: sid(customer), name: customer.name || 'Customer', phone: side !== 'customer' ? customer.phone_number || '' : undefined }
      : { id: sid(request.customer_id) },
    order_id: sid(request.order_id),
    event: request.event,
    delivery_location: request.delivery_location,
    destination_district: district ? { code: district.code, name: district.name } : null,
    pickup: request.pickup,
    route: request.route,
    trigger_reasons: request.trigger_reasons || [],
    trigger_messages: (request.trigger_reasons || []).map((r) => TRIGGER_MESSAGES[r]).filter(Boolean),
    calculated_fee_rwf: request.calculated_fee_rwf ?? null,
    auto_ceiling_rwf: request.auto_ceiling_rwf ?? null,
    requested_delivery_at: request.requested_delivery_at,
    instructions: request.instructions || '',
    info_request: request.info_request || '',
    decline_reason: request.decline_reason || '',
    cancel_reason: request.cancel_reason || '',
    dispute: request.dispute?.raised_at ? request.dispute : null,
    agreed_fee_rwf: request.agreed_fee_rwf ?? null,
    agreed_at: request.agreed_at ?? null,
    accepted_quotation_id: sid(request.accepted_quotation_id),
    active_quotation: serializeQuotation(open),
    quotations: quotations ? quotations.map(serializeQuotation) : undefined,
    conversation_id: sid(request.conversation_id),
    unread_count: unread,
    chat_open: CHAT_OPEN_STATUSES.includes(request.status),
    // What this side may do now (still checked on every action).
    allowed_actions: role === 'admin' ? allowedNext(request.status, 'admin') : actionsFor(request, role, open),
    // Ready to book the event with this delivery fee.
    can_checkout: side === 'customer' && request.status === 'quotation_accepted' && !request.order_id,
    status_history: request.status_history || [],
    created_at: request.created_at,
    updated_at: request.updated_at,
  };
}

function actionsFor(request, role, openQuotation) {
  const next = allowedNext(request.status, role);
  const actions = [];
  if (role === 'vendor') {
    if (next.includes('negotiation_accepted')) actions.push('accept_negotiation');
    if (next.includes('awaiting_customer_information')) actions.push('request_information');
    if (next.includes('vendor_declined')) actions.push('decline');
    if (QUOTABLE_STATUSES.includes(request.status)) actions.push(openQuotation ? 'revise_quotation' : 'submit_quotation');
    if (openQuotation) actions.push('withdraw_quotation');
  }
  if (role === 'customer') {
    if (request.status === 'awaiting_customer_information') actions.push('provide_information');
    if (openQuotation && request.status === 'quotation_submitted') actions.push('accept_quotation', 'request_revision', 'reject_quotation');
    if (next.includes('customer_cancelled') && !request.order_id) actions.push('cancel');
  }
  if (next.includes('disputed')) actions.push('dispute');
  if (CHAT_OPEN_STATUSES.includes(request.status)) actions.push('send_message');
  return actions;
}

/* -------------------------------- service -------------------------------- */

class SpecialDeliveryService {
  #timer = null;

  /** Expires quotations whose validity ended, every few minutes. */
  start() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = setInterval(() => this.expireQuotations().catch((e) => console.error('[special-delivery] expiry:', e.message)), EXPIRY_SWEEP_MS);
    this.#timer.unref?.();
  }

  /* ------------------------------- customer ------------------------------ */

  /**
   * The customer asks a kitchen for a special big-event delivery. Only when
   * automatic pricing can't be used (outside coverage, above the ceiling…)
   * and the kitchen delivers big events at all.
   */
  async create(customer, body = {}) {
    if (!mongoose.isValidObjectId(body.vendor_id)) {
      throw ApiError.badRequest('vendor_id must be a valid id.', { vendor_id: 'expected a valid id' });
    }
    const vendor = await vendorRepository.findActiveById(body.vendor_id);
    if (!vendor) throw ApiError.notFound('Kitchen not found.', 'VENDOR_NOT_FOUND');
    const offer = serializeEventOffer(vendor);
    if (!offer) throw new ApiError(409, 'EVENTS_UNAVAILABLE', "This kitchen isn't taking big-event orders right now.");

    const location = parseDeliveryLocation(body.delivery_location);
    const eventAt = parseScheduledFor(body.event_at, { minLeadMinutes: 0, maxDaysAhead: EVENT_ORDER.max_days_ahead });
    if (eventAt.getTime() < Date.now() + EVENT_ORDER.min_lead_hours * HOUR_MS) {
      throw ApiError.badRequest(`Big events must be at least ${EVENT_ORDER.min_lead_hours / 24} days away.`, {
        event_at: `expected at least ${EVENT_ORDER.min_lead_hours} hours from now`,
      });
    }
    const requestedAt = body.requested_delivery_at ? futureDate(body.requested_delivery_at, 'requested_delivery_at', 'The delivery time') : eventAt;
    if (requestedAt.getTime() > eventAt.getTime()) {
      throw ApiError.badRequest('The delivery time must be before or at the start of the event.', { requested_delivery_at: 'after the event' });
    }
    let guests = null;
    if (body.guests !== undefined && body.guests !== null && body.guests !== '') {
      guests = Number(body.guests);
      if (!Number.isInteger(guests) || guests < 1 || guests > 100000) {
        throw ApiError.badRequest('guests must be a whole number from 1 to 100,000.', { guests: 'expected 1–100000' });
      }
    }
    const pkg = typeof body.package_id === 'string' ? eventPackageFor(vendor).packages.find((p) => p.id === body.package_id) : null;

    const price = await bigEventDeliveryService.priceFor(vendor, location);
    if (price.status === 'unavailable') {
      throw new ApiError(409, 'BIG_EVENT_DELIVERY_UNAVAILABLE', price.message);
    }
    if (price.status === 'automatic') {
      throw new ApiError(
        409,
        'AUTOMATIC_PRICE_AVAILABLE',
        `This destination has an automatic delivery fee of ${rwf(price.fee_rwf)}, so no special arrangement is needed. Book the event directly.`
      );
    }

    const seq = await Counter.next('special_delivery');
    const now = new Date();
    let request;
    try {
      request = await SpecialDeliveryRequest.create({
        reference: `SD-${String(seq).padStart(6, '0')}`,
        customer_id: customer._id,
        vendor_id: vendor._id,
        event: {
          package_id: pkg?.id || '',
          package_name: pkg?.name || '',
          guests,
          event_at: eventAt,
          description: text(body.event_description, 'event_description', { max: 500, label: 'The event description' }),
        },
        delivery_location: location,
        destination_district: price.destination_district?.code ?? null,
        pickup: price.pickup,
        route: { distance_m: price.distance_m, distance_source: price.distance_source, duration_minutes: price.duration_minutes },
        trigger_reasons: price.reasons,
        calculated_fee_rwf: price.calculated_fee_rwf,
        auto_ceiling_rwf: price.ceiling_rwf,
        requested_delivery_at: requestedAt,
        instructions: text(body.instructions, 'instructions', { label: 'Delivery instructions' }),
        status: 'pending_vendor_review',
        dedupe_key: `cv:${customer._id}:${vendor._id}`,
        status_history: [{ from: null, to: 'pending_vendor_review', actor_role: 'customer', actor_id: customer._id, reason: price.reasons.join(', '), at: now }],
      });
    } catch (error) {
      if (error?.code === 11000) {
        const existing = await SpecialDeliveryRequest.findOne({ dedupe_key: `cv:${customer._id}:${vendor._id}`, is_active: true }).lean();
        throw new ApiError(
          409,
          'ACTIVE_REQUEST_EXISTS',
          `You already have an open special delivery request with this kitchen (${existing?.reference ?? 'open'}). Continue that one, or cancel it first.`,
          { request_id: sid(existing) }
        );
      }
      throw error;
    }
    request = request.toObject();

    notificationService
      .notifyVendor(vendor._id, {
        type: 'special_delivery_request',
        title: `Special delivery request ${request.reference}`,
        body: `${customer.name || 'A customer'} asks for a big-event delivery to ${location.address}. Review it to accept, ask for details or decline.`,
        link: `/vendor-dashboard/special-deliveries?request=${request._id}`,
        data: { special_delivery_request_id: String(request._id), reference: request.reference },
      })
      .catch(() => null);
    return this.#detail(request, 'customer');
  }

  async listForCustomer(customer, query = {}) {
    return this.#list({ customer_id: customer._id }, 'customer', query);
  }

  async getForCustomer(customer, id) {
    return this.#detail(await this.#own('customer', customer, id), 'customer');
  }

  async cancel(customer, id, body = {}) {
    const request = await this.#own('customer', customer, id);
    if (request.order_id) {
      throw ApiError.conflict('This agreement is part of an order. Cancel the order instead.', 'REQUEST_HAS_ORDER');
    }
    const reason = text(body.reason, 'reason', { max: 500, label: 'The reason' });
    await this.#withdrawOpenQuotation(request, 'Request cancelled by the customer');
    const updated = await transitionRequest(request, 'customer_cancelled', CUSTOMER(customer), { reason, set: { cancel_reason: reason } });
    await this.#systemNote(updated, `The customer cancelled this special delivery request${reason ? `: ${reason}` : '.'}`);
    this.#notifyVendor(updated, 'Special delivery cancelled', `${updated.reference} was cancelled by the customer.`);
    return this.#detail(updated, 'customer');
  }

  /** The customer answers the kitchen's question; the kitchen reviews again. */
  async provideInformation(customer, id, body = {}) {
    const request = await this.#own('customer', customer, id);
    const message = text(body.message, 'message', { required: true, label: 'Your answer' });
    const updated = await transitionRequest(request, 'pending_vendor_review', CUSTOMER(customer), { reason: 'Customer provided information' });
    const conversation = await this.#conversation(updated);
    await chatRepository.addMessage(conversation, { role: 'customer', authorId: customer._id, body: message });
    this.#notifyVendor(updated, `More details for ${updated.reference}`, message);
    return this.#detail(updated, 'customer');
  }

  /** Accepts the open quotation: the delivery fee is locked for the order. */
  async acceptQuotation(customer, id, quotationId) {
    await this.expireQuotations();
    const request = await this.#own('customer', customer, id);
    const quotation = await this.#openQuotation(request, quotationId);
    const updated = await transitionRequest(request, 'quotation_accepted', CUSTOMER(customer), {
      reason: `Accepted ${quotation.reference} (${rwf(quotation.fee_rwf)})`,
      set: { agreed_fee_rwf: quotation.fee_rwf, agreed_at: new Date(), accepted_quotation_id: quotation._id, active_quotation_id: null },
    });
    try {
      await transitionQuotation(quotation, 'accepted', CUSTOMER(customer), { reason: 'Accepted by the customer' });
    } catch (error) {
      // The quotation changed at the same moment (expired / withdrawn): undo.
      await SpecialDeliveryRequest.updateOne(
        { _id: updated._id, status: 'quotation_accepted' },
        {
          $set: { status: request.status, agreed_fee_rwf: null, agreed_at: null, accepted_quotation_id: null },
          $push: { status_history: { from: 'quotation_accepted', to: request.status, actor_role: 'system', reason: 'Quotation changed while accepting', at: new Date() } },
        }
      );
      throw error;
    }
    await this.#systemNote(updated, `The customer accepted quotation ${quotation.reference}: delivery fee ${rwf(quotation.fee_rwf)}.`);
    this.#notifyVendor(updated, `Quotation ${quotation.reference} accepted`, `The customer agreed to ${rwf(quotation.fee_rwf)} for delivery. They can now book and pay the event.`);
    return this.#detail(updated, 'customer');
  }

  /** "Request another price": back to the chat, the kitchen may revise. */
  async requestRevision(customer, id, quotationId, body = {}) {
    return this.#declineQuotation(customer, id, quotationId, body, 'quotation_revision_requested', 'asked for a different price');
  }

  async rejectQuotation(customer, id, quotationId, body = {}) {
    return this.#declineQuotation(customer, id, quotationId, body, 'quotation_rejected', 'rejected the quotation');
  }

  async #declineQuotation(customer, id, quotationId, body, to, verb) {
    await this.expireQuotations();
    const request = await this.#own('customer', customer, id);
    const quotation = await this.#openQuotation(request, quotationId);
    const note = text(body.note ?? body.reason, 'note', { max: 500, label: 'The note' });
    const updated = await transitionRequest(request, to, CUSTOMER(customer), { reason: note, set: { active_quotation_id: null } });
    await transitionQuotation(quotation, 'rejected', CUSTOMER(customer), { reason: note || verb });
    await this.#systemNote(updated, `The customer ${verb} (${quotation.reference}, ${rwf(quotation.fee_rwf)})${note ? `: ${note}` : '.'}`);
    this.#notifyVendor(updated, `Customer ${verb}`, `${updated.reference}: ${note || 'Open the chat to continue.'}`);
    return this.#detail(updated, 'customer');
  }

  /* -------------------------------- vendor ------------------------------- */

  async listForVendor(vendor, query = {}) {
    return this.#list({ vendor_id: vendor._id }, 'vendor', query);
  }

  async getForVendor(vendor, id) {
    return this.#detail(await this.#own('vendor', vendor, id), 'vendor');
  }

  async acceptNegotiation(vendor, id, body = {}) {
    const request = await this.#own('vendor', vendor, id);
    const message = text(body.message, 'message', { label: 'The message' });
    const conversation = await this.#conversation(request);
    const updated = await transitionRequest(request, 'negotiation_accepted', VENDOR(vendor), {
      reason: 'Kitchen accepted to negotiate',
      set: { conversation_id: conversation._id },
    });
    await this.#systemNote(updated, `${vendor.name || 'The kitchen'} is open to arranging this delivery. Discuss the details here; the price is only agreed through a formal quotation.`);
    if (message) await chatRepository.addMessage(conversation, { role: 'vendor', authorId: vendor._id, body: message });
    this.#notifyCustomer(updated, `${vendor.name || 'The kitchen'} will discuss your delivery`, `Special delivery ${updated.reference}: open the chat to arrange the delivery.`);
    return this.#detail(updated, 'vendor');
  }

  async requestInformation(vendor, id, body = {}) {
    const request = await this.#own('vendor', vendor, id);
    const question = text(body.message, 'message', { required: true, label: 'Your question' });
    const conversation = await this.#conversation(request);
    const updated = await transitionRequest(request, 'awaiting_customer_information', VENDOR(vendor), {
      reason: question,
      set: { info_request: question, conversation_id: conversation._id },
    });
    await chatRepository.addMessage(conversation, { role: 'vendor', authorId: vendor._id, body: question });
    this.#notifyCustomer(updated, `${vendor.name || 'The kitchen'} needs more details`, question);
    return this.#detail(updated, 'vendor');
  }

  async decline(vendor, id, body = {}) {
    const request = await this.#own('vendor', vendor, id);
    const reason = text(body.reason, 'reason', { required: true, max: 500, label: 'The reason' });
    await this.#withdrawOpenQuotation(request, 'Request declined by the kitchen');
    const updated = await transitionRequest(request, 'vendor_declined', VENDOR(vendor), { reason, set: { decline_reason: reason } });
    if (updated.conversation_id) await this.#systemNote(updated, `The kitchen declined this delivery: ${reason}`);
    this.#notifyCustomer(updated, `${vendor.name || 'The kitchen'} declined your special delivery`, `${updated.reference}: ${reason}`);
    return this.#detail(updated, 'vendor');
  }

  /**
   * The kitchen's formal price. A quotation is never edited: a new one
   * (next version) supersedes the open one.
   */
  async submitQuotation(vendor, id, body = {}) {
    await this.expireQuotations();
    const request = await this.#own('vendor', vendor, id);
    if (!QUOTABLE_STATUSES.includes(request.status)) {
      throw new ApiError(409, 'INVALID_TRANSITION', `A quotation can't be submitted while the request is "${STATUS_LABELS[request.status]}". Accept to negotiate first.`);
    }
    const fee = Number(body.fee_rwf);
    if (body.fee_rwf === '' || body.fee_rwf === null || !Number.isInteger(fee) || fee < 1 || fee > MAX_FEE_RWF) {
      throw ApiError.badRequest(`The delivery fee must be a whole number of RWF from 1 to ${MAX_FEE_RWF.toLocaleString('en-US')}.`, { fee_rwf: 'expected a positive whole RWF amount' });
    }
    const proposedAt = futureDate(body.proposed_delivery_at ?? request.requested_delivery_at, 'proposed_delivery_at', 'The delivery date and time');
    if (request.event?.event_at && proposedAt.getTime() > new Date(request.event.event_at).getTime()) {
      throw ApiError.badRequest('The delivery must arrive before or at the start of the event.', { proposed_delivery_at: 'after the event' });
    }
    const codes = ARRANGEMENTS.map((a) => a.code);
    const arrangements = [...new Set(Array.isArray(body.arrangements) ? body.arrangements : body.arrangement ? [body.arrangement] : [])];
    if (arrangements.length === 0 || arrangements.some((code) => !codes.includes(code))) {
      throw ApiError.badRequest('Say how the delivery will be arranged (own vehicle, rented vehicle, third-party transport, multiple trips or other).', {
        arrangements: `expected one or more of: ${codes.join(', ')}`,
      });
    }
    const description = text(body.arrangement_description, 'arrangement_description', { required: true, label: 'The delivery arrangement' });
    const conditions = text(body.conditions, 'conditions', { label: 'The conditions' });

    const settings = bigEventDeliverySettingsService.settings();
    let hours = settings.quotation_validity_hours;
    if (body.valid_hours !== undefined && body.valid_hours !== null && body.valid_hours !== '') {
      hours = Number(body.valid_hours);
      if (!Number.isInteger(hours) || hours < 1 || hours > settings.quotation_validity_hours) {
        throw ApiError.badRequest(`A quotation can stay valid for 1 to ${settings.quotation_validity_hours} hours.`, { valid_hours: `expected 1–${settings.quotation_validity_hours}` });
      }
    }
    // Never valid beyond the delivery itself.
    const validUntil = new Date(Math.min(Date.now() + hours * HOUR_MS, proposedAt.getTime()));

    const previous = await DeliveryQuotation.findOne({ request_id: request._id, status: 'submitted' }).lean();
    const version = (request.quotations_count || 0) + 1;
    const reference = `${request.reference}-Q${version}`;
    const updated = await transitionRequest(request, 'quotation_submitted', VENDOR(vendor), {
      reason: `${previous ? 'Revised' : 'Submitted'} ${reference}: ${rwf(fee)}`,
      inc: { quotations_count: 1 },
    });
    if (previous) await transitionQuotation(previous, 'superseded', VENDOR(vendor), { reason: `Replaced by ${reference}` });
    const now = new Date();
    let quotation;
    try {
      quotation = (
        await DeliveryQuotation.create({
          request_id: request._id,
          vendor_id: vendor._id,
          customer_id: request.customer_id,
          version,
          reference,
          fee_rwf: fee,
          destination: {
            address: request.delivery_location.address,
            latitude: request.delivery_location.latitude,
            longitude: request.delivery_location.longitude,
          },
          proposed_delivery_at: proposedAt,
          arrangements,
          arrangement_description: description,
          conditions,
          valid_until: validUntil,
          status: 'submitted',
          submitted_by: vendor._id,
          submitted_at: now,
          status_history: [{ from: 'draft', to: 'submitted', actor_role: 'vendor', actor_id: vendor._id, at: now }],
        })
      ).toObject();
    } catch (error) {
      if (error?.code === 11000) throw ApiError.conflict('Another quotation was just submitted. Refresh and try again.', 'QUOTATION_CHANGED');
      throw error;
    }
    const withQuote = await SpecialDeliveryRequest.findByIdAndUpdate(updated._id, { $set: { active_quotation_id: quotation._id } }, { returnDocument: 'after' }).lean();
    const conversation = await this.#conversation(withQuote);
    await chatRepository.addMessage(conversation, {
      role: 'vendor',
      authorId: vendor._id,
      kind: 'quotation',
      quotationId: quotation._id,
      body: `${previous ? 'Revised quotation' : 'Quotation'} ${reference}: ${rwf(fee)} for delivery.`,
    });
    this.#notifyCustomer(
      withQuote,
      `${previous ? 'Revised quotation' : 'Delivery quotation'} from ${vendor.name || 'the kitchen'}`,
      `${reference}: ${rwf(fee)}, valid until ${validUntil.toLocaleString('en-GB', { timeZone: 'Africa/Kigali' })}. Accept, ask for another price or reject it.`
    );
    return this.#detail(withQuote, 'vendor');
  }

  async withdrawQuotation(vendor, id, quotationId, body = {}) {
    const request = await this.#own('vendor', vendor, id);
    const quotation = await this.#openQuotation(request, quotationId);
    const reason = text(body.reason, 'reason', { max: 500, label: 'The reason' });
    await transitionQuotation(quotation, 'withdrawn', VENDOR(vendor), { reason });
    const updated = await transitionRequest(request, 'negotiating', VENDOR(vendor), { reason: `Withdrew ${quotation.reference}`, set: { active_quotation_id: null } });
    await this.#systemNote(updated, `The kitchen withdrew quotation ${quotation.reference}${reason ? `: ${reason}` : '.'}`);
    this.#notifyCustomer(updated, 'Quotation withdrawn', `${quotation.reference} was withdrawn by the kitchen.`);
    return this.#detail(updated, 'vendor');
  }

  /* ------------------------- customer + vendor chat ---------------------- */

  async messages(side, account, id, query = {}) {
    const request = await this.#own(side, account, id);
    if (!request.conversation_id) return { messages: [], has_more: false, read_by_other_at: null, privacy_note: PRIVACY_NOTE, chat_open: false };
    const conversation = await ChatConversation.findById(request.conversation_id).lean();
    const limit = Math.min(Number(query.limit) || 50, 100);
    const parseDate = (raw) => (raw ? new Date(raw) : null);
    const after = parseDate(query.after);
    const before = parseDate(query.before);
    if ((after && Number.isNaN(after.getTime())) || (before && Number.isNaN(before.getTime()))) {
      throw ApiError.badRequest('before/after must be dates.', { after: 'expected an ISO date' });
    }
    const rows = await chatRepository.listMessages(conversation._id, { after, before, limit });
    if ((side === 'customer' ? conversation.unread_by_customer : conversation.unread_by_vendor) > 0) {
      await chatRepository.markRead(side, conversation._id);
    }
    const otherReadAt = side === 'customer' ? conversation.vendor_read_at : conversation.customer_read_at;
    return {
      messages: rows.map((m) => ({
        ...serializeMessage(m, side),
        // Read receipts on your own messages.
        read: m.author_role === side ? Boolean(otherReadAt && new Date(otherReadAt) >= new Date(m.created_at)) : undefined,
      })),
      has_more: !after && rows.length === limit,
      read_by_other_at: otherReadAt ?? null,
      chat_open: CHAT_OPEN_STATUSES.includes(request.status),
      privacy_note: PRIVACY_NOTE,
    };
  }

  /** Text, delivery instructions or a shared location (`kind: 'location'`). */
  async sendMessage(side, account, id, body = {}) {
    const request = await this.#chatReady(side, account, id);
    const conversation = await this.#conversation(request);
    let message;
    if (body.kind === 'location') {
      const lat = Number(body.latitude ?? body.location?.latitude);
      const lng = Number(body.longitude ?? body.location?.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        throw ApiError.badRequest('Share a valid location.', { location: 'expected latitude and longitude' });
      }
      const label = text(body.label ?? body.location?.label ?? body.body, 'label', { max: 120, label: 'The location name' });
      message = await chatRepository.addMessage(conversation, {
        role: side,
        authorId: account._id,
        kind: 'location',
        body: label,
        location: { latitude: lat, longitude: lng, label },
        preview: `📍 ${label || 'Shared a location'}`,
      });
    } else {
      message = await chatRepository.addMessage(conversation, { role: side, authorId: account._id, body: parseBody(body.body ?? body.message) });
    }
    await this.#afterMessage(side, account, request, message);
    return { message: serializeMessage(message.message, side) };
  }

  async sendImage(side, account, id, file, body = {}) {
    if (!file) throw ApiError.badRequest('Choose an image to send.', { image: 'expected a multipart file field named "image"' });
    const request = await this.#chatReady(side, account, id);
    const conversation = await this.#conversation(request);
    const caption = text(body.body ?? body.caption, 'caption', { max: 300, label: 'The caption' });
    const message = await chatRepository.addMessage(conversation, {
      role: side,
      authorId: account._id,
      kind: 'image',
      body: caption,
      attachmentUrl: buildPublicUrl(file.filename),
      preview: `📷 ${caption || 'Photo'}`,
    });
    await this.#afterMessage(side, account, request, message);
    return { message: serializeMessage(message.message, side) };
  }

  async markRead(side, account, id) {
    const request = await this.#own(side, account, id);
    if (request.conversation_id) await chatRepository.markRead(side, request.conversation_id);
    return { ok: true };
  }

  /** Customer or kitchen: something went wrong with an agreed delivery. */
  async dispute(side, account, id, body = {}) {
    const request = await this.#own(side, account, id);
    const reason = text(body.reason, 'reason', { required: true, max: 1000, label: 'What went wrong' });
    const updated = await transitionRequest(request, 'disputed', { role: side, id: account._id }, {
      reason,
      set: { dispute: { raised_by: side, reason, raised_at: new Date(), resolution: '', resolved_at: null, resolved_by: null } },
    });
    await this.#systemNote(updated, `A dispute was opened by the ${side === 'customer' ? 'customer' : 'kitchen'}: ${reason}. Our support team will review it.`);
    notificationService
      .notifyAdmin({
        type: 'special_delivery_dispute',
        title: `Special delivery dispute ${updated.reference}`,
        body: reason.slice(0, 140),
        link: `/admin-dashboard/delivery-management?request=${updated._id}`,
        data: { special_delivery_request_id: String(updated._id) },
      })
      .catch(() => null);
    (side === 'customer' ? this.#notifyVendor : this.#notifyCustomer).call(this, updated, `Dispute opened on ${updated.reference}`, reason);
    return this.#detail(updated, side);
  }

  /* --------------------------- order integration ------------------------- */

  /**
   * Event checkout with an agreed special delivery: the request (owned by
   * the customer, for this kitchen, price accepted and not used by another
   * order) and its accepted quotation. Claims it for `orderId` atomically.
   */
  async claimForOrder(customerId, requestId, vendorId, orderId) {
    if (!mongoose.isValidObjectId(requestId)) {
      throw ApiError.badRequest('special_delivery_request_id must be a valid id.', { special_delivery_request_id: 'expected a valid id' });
    }
    const request = await SpecialDeliveryRequest.findOne({ _id: requestId, customer_id: customerId }).lean();
    if (!request) throw ApiError.notFound('Special delivery request not found.', 'SPECIAL_DELIVERY_NOT_FOUND');
    if (String(request.vendor_id) !== String(vendorId)) {
      throw ApiError.badRequest('This delivery agreement is with another kitchen.', { special_delivery_request_id: 'other kitchen' });
    }
    if (request.status !== 'quotation_accepted' || request.agreed_fee_rwf == null) {
      throw new ApiError(409, 'NO_AGREED_DELIVERY', 'Accept a delivery quotation from the kitchen before booking.');
    }
    if (request.order_id) {
      throw new ApiError(409, 'AGREEMENT_ALREADY_USED', 'This delivery agreement is already used by an order. Pay or cancel that order.');
    }
    const quotation = await DeliveryQuotation.findOne({ _id: request.accepted_quotation_id, status: 'accepted' }).lean();
    if (!quotation) throw new ApiError(409, 'NO_AGREED_DELIVERY', 'The accepted quotation could not be found.');
    const claimed = await SpecialDeliveryRequest.findOneAndUpdate(
      { _id: request._id, status: 'quotation_accepted', order_id: null },
      { $set: { order_id: orderId, dedupe_key: `order:${orderId}` } },
      { returnDocument: 'after' }
    ).lean();
    if (!claimed) throw new ApiError(409, 'AGREEMENT_ALREADY_USED', 'This delivery agreement was just used by another order.');
    return { request: claimed, quotation };
  }

  /** Gives the agreement back when the order could not be created. */
  async releaseClaim(requestId, orderId) {
    const request = await SpecialDeliveryRequest.findOne({ _id: requestId, order_id: orderId }).lean();
    if (!request) return;
    await SpecialDeliveryRequest.updateOne(
      { _id: requestId, order_id: orderId },
      { $set: { order_id: null, dedupe_key: `cv:${request.customer_id}:${request.vendor_id}` } }
    );
  }

  /** The event order was paid (deposit or full): the delivery is confirmed. */
  async onOrderPaid(order) {
    const request = await SpecialDeliveryRequest.findOne({ _id: order.special_delivery_request_id, order_id: order._id }).lean();
    if (!request || request.status !== 'quotation_accepted') return;
    const updated = await transitionRequest(request, 'delivery_confirmed', SYSTEM, { reason: `Order ${order.order_number} paid` });
    await this.#systemNote(updated, `Order ${order.order_number} is booked and paid. The delivery is confirmed for ${rwf(updated.agreed_fee_rwf)}.`);
    this.#notifyVendor(updated, `Delivery confirmed: ${updated.reference}`, `Order ${order.order_number} was paid with the agreed delivery fee of ${rwf(updated.agreed_fee_rwf)}.`);
  }

  /** Follows the order: delivered → completed, cancelled → cancelled (history kept). */
  async syncWithOrder(order) {
    const request = await SpecialDeliveryRequest.findOne({ _id: order.special_delivery_request_id, order_id: order._id }).lean();
    if (!request) return;
    if (order.status === 'cancelled' && ['quotation_accepted', 'delivery_confirmed'].includes(request.status)) {
      const reason = `Order ${order.order_number} was cancelled${order.cancel_reason ? `: ${order.cancel_reason}` : ''}`;
      const updated = await transitionRequest(request, 'customer_cancelled', SYSTEM, { reason, set: { cancel_reason: reason } });
      await this.#systemNote(updated, `${reason}. The delivery agreement is closed (its history is kept).`);
    } else if (['delivered', 'completed'].includes(order.status) && request.status === 'delivery_confirmed') {
      const updated = await transitionRequest(request, 'completed', SYSTEM, { reason: `Order ${order.order_number} delivered` });
      await this.#systemNote(updated, 'The event order was delivered. Thank you!');
    }
  }

  /** Quotations past their validity become expired (the customer can't accept them). */
  async expireQuotations() {
    const due = await DeliveryQuotation.find({ status: 'submitted', valid_until: { $lte: new Date() } }).limit(200).lean();
    for (const quotation of due) {
      try {
        await transitionQuotation(quotation, 'expired', SYSTEM, { reason: 'Validity period ended' });
        const request = await SpecialDeliveryRequest.findById(quotation.request_id).lean();
        if (request?.status === 'quotation_submitted') {
          const updated = await transitionRequest(request, 'quotation_expired', SYSTEM, {
            reason: `${quotation.reference} expired`,
            set: { active_quotation_id: null },
          });
          await this.#systemNote(updated, `Quotation ${quotation.reference} expired. The kitchen can send a new one.`);
          this.#notifyVendor(updated, `Quotation ${quotation.reference} expired`, 'Send a new quotation if the customer still wants the delivery.');
          this.#notifyCustomer(updated, `Quotation ${quotation.reference} expired`, 'Ask the kitchen for a new quotation in the chat.');
        }
      } catch (error) {
        if (!['QUOTATION_CHANGED', 'REQUEST_CHANGED', 'INVALID_TRANSITION'].includes(error.code)) throw error;
      }
    }
    return due.length;
  }

  /* -------------------------------- admin -------------------------------- */

  async adminList(query = {}) {
    const filter = {};
    if (query.status) filter.status = query.status;
    if (query.vendor_id) filter.vendor_id = parseObjectId(query.vendor_id, 'vendor_id');
    if (query.customer_id) filter.customer_id = parseObjectId(query.customer_id, 'customer_id');
    if (typeof query.search === 'string' && query.search.trim()) {
      filter.reference = new RegExp(query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    return this.#list(filter, 'admin', query);
  }

  async adminGet(id) {
    parseObjectId(id, 'request_id');
    const request = await SpecialDeliveryRequest.findById(id).lean();
    if (!request) throw ApiError.notFound('Special delivery request not found.', 'SPECIAL_DELIVERY_NOT_FOUND');
    const detail = await this.#detail(request, 'admin');
    const messages = request.conversation_id ? await chatRepository.listMessages(request.conversation_id, { limit: 200 }) : [];
    return { ...detail, messages: messages.map((m) => serializeMessage(m)) };
  }

  /**
   * Admin closes a dispute:
   *  - 'customer_cancelled': the arrangement and its order are cancelled; the
   *    normal cancellation refund gives back everything paid (less anything
   *    already refunded). Not possible once the food was delivered.
   *  - 'completed' / 'delivery_confirmed': the delivery stands (delivered, or
   *    still to happen). Optionally `fee_reduction_rwf` lowers the agreed
   *    delivery fee: it comes off the unpaid balance first, and whatever the
   *    customer already overpaid is refunded. The kitchen is paid that much
   *    less. The kitchen's payout, frozen during the dispute, is released.
   * Money moves only through the order's settlement and refundService.
   */
  async resolveDispute(admin, id, body = {}, req = null) {
    parseObjectId(id, 'request_id');
    const request = await SpecialDeliveryRequest.findById(id).lean();
    if (!request) throw ApiError.notFound('Special delivery request not found.', 'SPECIAL_DELIVERY_NOT_FOUND');
    const outcomes = ['completed', 'customer_cancelled', 'delivery_confirmed'];
    if (!outcomes.includes(body.outcome)) {
      throw ApiError.badRequest(`outcome must be one of: ${outcomes.join(', ')}.`, { outcome: `expected one of ${outcomes.join(', ')}` });
    }
    if (request.status !== 'disputed') {
      throw new ApiError(409, 'INVALID_TRANSITION', 'Only a special delivery in dispute can be resolved.');
    }
    const resolution = text(body.resolution, 'resolution', { required: true, label: 'The resolution' });
    const rawReduction = body.fee_reduction_rwf ?? body.refund_rwf;
    const reduction = rawReduction === undefined || rawReduction === null || rawReduction === '' ? 0 : Number(rawReduction);
    if (!Number.isInteger(reduction) || reduction < 0) {
      throw ApiError.badRequest('The delivery fee reduction must be a whole number of RWF (0 for none).', { fee_reduction_rwf: 'expected a whole RWF amount' });
    }
    const order = request.order_id ? await Order.findById(request.order_id).lean() : null;
    const delivered = order && ['delivered', 'completed'].includes(order.status);

    // Check everything before changing anything.
    let plan = null;
    if (body.outcome === 'customer_cancelled') {
      if (reduction > 0) {
        throw ApiError.badRequest('Cancelling refunds what the customer paid automatically; leave the fee reduction empty.', { fee_reduction_rwf: 'not with a cancellation' });
      }
      if (delivered) {
        throw ApiError.conflict('The food was already delivered. Resolve as completed, with a delivery fee reduction if the customer is owed money.', 'ORDER_ALREADY_DELIVERED');
      }
    } else if (reduction > 0) {
      plan = await this.#planFeeReduction(order, reduction);
    }

    const updated = await transitionRequest(request, body.outcome, ADMIN(admin), {
      reason: resolution,
      set: {
        'dispute.resolution': resolution,
        'dispute.resolved_at': new Date(),
        'dispute.resolved_by': admin?._id ?? null,
        'dispute.fee_reduced_by_rwf': plan ? reduction : 0,
        'dispute.refund_rwf': plan ? plan.cash : 0,
      },
    });

    // eslint-disable-next-line global-require
    const settlementService = require('./settlementService');
    let refundNote = '';
    if (plan) {
      const { refund } = await this.#applyFeeReduction(order, plan, { admin, request: updated, reason: resolution });
      if (refund) await SpecialDeliveryRequest.updateOne({ _id: updated._id }, { $set: { 'dispute.refund_id': refund._id } });
      refundNote =
        ` The delivery fee was reduced by ${rwf(reduction)}` +
        (plan.cash > 0 ? `; ${rwf(plan.cash)} is being refunded to the customer` : '') +
        (plan.fromBalance > 0 ? `; the balance due is ${rwf(plan.fromBalance)} lower` : '') +
        '.';
    }
    if (body.outcome === 'customer_cancelled' && order && order.status !== 'cancelled') {
      // The normal admin cancellation: settlement opens the refund.
      // eslint-disable-next-line global-require
      await require('./adminOrderService').cancel(
        order._id,
        { reason: `Special delivery ${updated.reference} cancelled by support: ${resolution}`.slice(0, 500) },
        admin,
        req
      );
      if (order.payment_status === 'paid') refundNote = ' The order was cancelled and what the customer paid is being refunded.';
    }
    // The kitchen's payout was frozen while the dispute was open.
    if (body.outcome !== 'customer_cancelled' && delivered) await settlementService.releaseOrder(order._id);

    await this.#systemNote(updated, `Support resolved the dispute: ${resolution}${refundNote}`);
    this.#notifyCustomer(updated, `Dispute resolved: ${updated.reference}`, `${resolution}${refundNote}`);
    this.#notifyVendor(updated, `Dispute resolved: ${updated.reference}`, `${resolution}${refundNote}`);
    const fresh = await SpecialDeliveryRequest.findById(updated._id).lean();
    return { previous: request, current: await this.#detail(fresh, 'admin') };
  }

  /**
   * How a delivery fee reduction is paid back. Only money the platform still
   * holds for a paid order can be refunded (a dispute freezes the payout, so
   * a disputed order is still held). Reducing an unpaid balance comes first;
   * cash = what was paid beyond the new total.
   */
  async #planFeeReduction(order, reduction) {
    if (!order) throw ApiError.conflict('There is no order for this agreement, so there is nothing to refund.', 'NO_ORDER');
    if (order.payment_status !== 'paid' || order.settlement_status !== 'held') {
      throw ApiError.conflict(
        'Only a paid order whose money is still held can have its delivery fee reduced. Cancel it instead, or refund manually.',
        'REFUND_NOT_POSSIBLE'
      );
    }
    const fee = Math.round(Number(order.delivery_fee_rwf) || 0);
    if (reduction > fee) {
      throw ApiError.badRequest(`The reduction can be at most the delivery fee (${rwf(fee)}).`, { fee_reduction_rwf: `at most ${fee}` });
    }
    const total = Math.round(Number(order.total_rwf) || 0);
    const paid = Math.round(Number(order.amount_paid_rwf ?? order.total_rwf) || 0);
    const alreadyRefunded = await refundRepository.totalForOrder(order._id);
    const newTotal = total - reduction;
    const netPaid = paid - alreadyRefunded;
    const cash = Math.max(0, netPaid - newTotal);
    const balanceUnpaid = order.deposit?.balance_rwf != null && !order.deposit.balance_paid_at;
    const fromBalance = balanceUnpaid ? Math.min(order.deposit.balance_rwf, reduction - cash) : 0;
    if (cash > 0 && (await refundRepository.findByOrderAndKind(order._id, 'delivery_fee_adjustment'))) {
      throw ApiError.conflict('This order already had its delivery fee refunded once. Refund any more by hand from the Refunds page.', 'ALREADY_ADJUSTED');
    }
    return { reduction, cash, fromBalance, newTotal, total, newBalance: balanceUnpaid ? order.deposit.balance_rwf - fromBalance : null };
  }

  async #applyFeeReduction(order, plan, { admin, request, reason }) {
    const now = new Date();
    const balancePaidOff = plan.newBalance === 0;
    const code = balancePaidOff ? String(crypto.randomInt(100000, 1000000)) : null;
    const updated = await Order.findOneAndUpdate(
      // Only if nothing moved since the plan was made.
      { _id: order._id, settlement_status: 'held', total_rwf: plan.total },
      {
        $inc: { delivery_fee_rwf: -plan.reduction, total_rwf: -plan.reduction, vendor_payout_rwf: -plan.reduction },
        $set: {
          ...(plan.newBalance != null ? { 'deposit.balance_rwf': plan.newBalance } : {}),
          // The reduction covered the whole balance: the order is fully paid.
          ...(balancePaidOff
            ? { 'deposit.balance_paid_at': now, pickup_code: code, pickup_code_sent_at: now, pickup_code_attempts: 0 }
            : {}),
        },
        $push: {
          'big_event_delivery.adjustments': { reduced_by_rwf: plan.reduction, refund_rwf: plan.cash, reason, by: admin?._id ?? null, at: now },
          status_history: {
            status: order.status,
            at: now,
            note: `Delivery fee reduced by ${rwf(plan.reduction)} by support (${request.reference})${plan.cash ? `, ${rwf(plan.cash)} refunded` : ''}`,
          },
        },
      },
      { returnDocument: 'after' }
    ).lean();
    if (!updated) throw ApiError.conflict('The order changed while resolving. Refresh and try again.', 'ORDER_CHANGED');

    // eslint-disable-next-line global-require
    const refundService = require('./refundService');
    const refund = plan.cash > 0
      ? await refundService.openDeliveryAdjustment(updated, { amountRwf: plan.cash, reason: `${request.reference}: ${reason}`, requestId: request._id })
      : null;
    if (refund) {
      await Order.updateOne({ _id: order._id }, { $set: { 'big_event_delivery.adjustments.$[last].refund_id': refund._id } }, {
        arrayFilters: [{ 'last.at': now }],
      });
    }
    if (balancePaidOff) {
      notificationService
        .notifyPickupCode(order.customer_id, { orderNumber: order.order_number, code, orderId: order._id, ready: false, kitchenBrings: true })
        .catch(() => null);
    }
    return { order: updated, refund };
  }

  /* ------------------------------- helpers ------------------------------- */

  async #own(side, account, id) {
    parseObjectId(id, 'request_id');
    const field = side === 'customer' ? 'customer_id' : 'vendor_id';
    const request = await SpecialDeliveryRequest.findOne({ _id: id, [field]: account._id }).lean();
    if (!request) throw ApiError.notFound('Special delivery request not found.', 'SPECIAL_DELIVERY_NOT_FOUND');
    return request;
  }

  async #openQuotation(request, quotationId) {
    parseObjectId(quotationId, 'quotation_id');
    const quotation = await DeliveryQuotation.findOne({ _id: quotationId, request_id: request._id }).lean();
    if (!quotation) throw ApiError.notFound('Quotation not found.', 'QUOTATION_NOT_FOUND');
    if (quotation.status !== 'submitted') {
      throw ApiError.conflict(`This quotation is ${quotation.status}, not open any more.`, 'QUOTATION_NOT_OPEN');
    }
    if (new Date(quotation.valid_until) <= new Date()) {
      throw ApiError.conflict('This quotation has expired. Ask the kitchen for a new one.', 'QUOTATION_EXPIRED');
    }
    return quotation;
  }

  async #withdrawOpenQuotation(request, reason) {
    const open = await DeliveryQuotation.findOne({ request_id: request._id, status: 'submitted' }).lean();
    if (open) await transitionQuotation(open, 'withdrawn', SYSTEM, { reason });
  }

  async #chatReady(side, account, id) {
    const request = await this.#own(side, account, id);
    if (!CHAT_OPEN_STATUSES.includes(request.status)) {
      throw ApiError.conflict(
        request.status === 'pending_vendor_review'
          ? 'The chat opens once the kitchen accepts to discuss this delivery.'
          : 'This special delivery is closed, so the chat is read-only.',
        'CHAT_CLOSED'
      );
    }
    return request;
  }

  async #afterMessage(side, account, request, { conversation }) {
    if (request.status === 'negotiation_accepted') {
      await transitionRequest(request, 'negotiating', SYSTEM, { reason: 'First message' }).catch(() => null);
    }
    const otherUnread = side === 'customer' ? conversation.unread_by_vendor : conversation.unread_by_customer;
    if (otherUnread === 1) {
      const title = `New message on ${request.reference}`;
      const body = conversation.last_message_preview || 'New message';
      if (side === 'customer') this.#notifyVendor(request, title, body, 'special_delivery_message');
      else this.#notifyCustomer(request, title, body, 'special_delivery_message');
    }
  }

  async #conversation(request) {
    const conversation = request.conversation_id
      ? await ChatConversation.findById(request.conversation_id).lean()
      : await chatRepository.findOrCreateForRequest(request);
    if (!request.conversation_id) {
      await SpecialDeliveryRequest.updateOne({ _id: request._id }, { $set: { conversation_id: conversation._id } });
      request.conversation_id = conversation._id;
    }
    return conversation;
  }

  async #systemNote(request, body) {
    const conversation = await this.#conversation(request);
    await chatRepository.addMessage(conversation, { role: 'system', kind: 'system', body: body.slice(0, 1000) });
  }

  #notifyVendor(request, title, body, type = 'special_delivery_update') {
    notificationService
      .notifyVendor(request.vendor_id, {
        type,
        title,
        body: String(body).slice(0, 200),
        link: `/vendor-dashboard/special-deliveries?request=${request._id}`,
        data: { special_delivery_request_id: String(request._id), reference: request.reference },
      })
      .catch(() => null);
  }

  #notifyCustomer(request, title, body, type = 'special_delivery_update') {
    notificationService
      .notifyCustomers([request.customer_id], {
        type,
        title,
        body: String(body).slice(0, 200),
        link: `/special-deliveries/${request._id}`,
        data: { special_delivery_request_id: String(request._id), reference: request.reference },
      })
      .catch(() => null);
  }

  async #detail(request, side) {
    const [vendor, customer, quotations, conversation] = await Promise.all([
      Vendor.findById(request.vendor_id, 'name profile_image_url phone').lean(),
      Customer.findById(request.customer_id, 'name phone_number').lean(),
      DeliveryQuotation.find({ request_id: request._id }).sort({ version: -1 }).lean(),
      request.conversation_id ? ChatConversation.findById(request.conversation_id).lean() : null,
    ]);
    const order = request.order_id
      ? await Order.findById(request.order_id, 'order_number status payment_status total_rwf delivery_fee_rwf settlement_status').lean()
      : null;
    // eslint-disable-next-line global-require
    const { serializeRefund } = require('./refundService');
    const refunds = order ? await refundRepository.listByOrder(order._id) : [];
    return {
      ...serializeRequest(request, side, { vendor, customer, quotations, conversation }),
      order: order
        ? {
            id: String(order._id),
            order_number: order.order_number,
            status: order.status,
            payment_status: order.payment_status,
            total_rwf: order.total_rwf,
            // After any reduction by support (agreed_fee_rwf keeps the agreed price).
            delivery_fee_rwf: order.delivery_fee_rwf,
            // The kitchen's payout is held while a dispute is open.
            payout_on_hold: request.status === 'disputed' && order.settlement_status === 'held',
          }
        : null,
      refunds: refunds.map((refund) => serializeRefund(refund, { admin: side === 'admin' })),
      arrangement_options: ARRANGEMENTS,
      quotation_max_valid_hours: bigEventDeliverySettingsService.settings().quotation_validity_hours,
    };
  }

  async #list(filter, side, query = {}) {
    const { limit, page, offset } = parseAdminListQuery(query, {
      defaultLimit: config.admin?.limits?.listDefault ?? 20,
      maxLimit: config.admin?.limits?.listMax ?? 100,
    });
    const where = { ...filter };
    if (query.scope === 'open') where.is_active = true;
    if (query.scope === 'closed') where.is_active = false;
    if (query.status && side !== 'admin') where.status = query.status;
    const [rows, total] = await Promise.all([
      SpecialDeliveryRequest.find(where).sort({ updated_at: -1 }).skip(offset).limit(limit).lean(),
      SpecialDeliveryRequest.countDocuments(where),
    ]);
    const vendorIds = [...new Set(rows.map((r) => String(r.vendor_id)))];
    const customerIds = [...new Set(rows.map((r) => String(r.customer_id)))];
    const conversationIds = rows.map((r) => r.conversation_id).filter(Boolean);
    const quotationIds = rows.map((r) => r.active_quotation_id).filter(Boolean);
    const [vendors, customers, conversations, quotations] = await Promise.all([
      Vendor.find({ _id: { $in: vendorIds } }, 'name profile_image_url phone').lean(),
      Customer.find({ _id: { $in: customerIds } }, 'name phone_number').lean(),
      ChatConversation.find({ _id: { $in: conversationIds } }).lean(),
      DeliveryQuotation.find({ _id: { $in: quotationIds } }).lean(),
    ]);
    const byId = (list) => new Map(list.map((row) => [String(row._id), row]));
    const [v, c, conv, q] = [byId(vendors), byId(customers), byId(conversations), byId(quotations)];
    return {
      items: rows.map((r) =>
        serializeRequest(r, side, {
          vendor: v.get(String(r.vendor_id)),
          customer: c.get(String(r.customer_id)),
          conversation: conv.get(String(r.conversation_id)) ?? null,
          quotations: r.active_quotation_id && q.get(String(r.active_quotation_id)) ? [q.get(String(r.active_quotation_id))] : [],
        })
      ).map(({ quotations: _omit, status_history: _h, ...rest }) => rest),
      total,
      page,
      limit,
    };
  }
}

module.exports = new SpecialDeliveryService();
module.exports.serializeQuotation = serializeQuotation;
