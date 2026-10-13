const crypto = require('crypto');
const config = require('../config');
const ApiError = require('../utils/ApiError');
const { parseEnum, parseRequiredText, parseObjectId } = require('../utils/adminValidators');
const complaintRepository = require('../repositories/complaintRepository');
const orderRepository = require('../repositories/orderRepository');
const deliveryRepository = require('../repositories/deliveryRepository');
const notificationRepository = require('../repositories/notificationRepository');
const notificationService = require('./notificationService');
const { COMPLAINT_CATEGORIES } = require('../models/Complaint');

const { maxMessageLength, maxSubjectLength } = config.support;

const STATUS_LABELS = {
  open: 'Waiting for support',
  in_review: 'Support is on it',
  resolved: 'Resolved',
  rejected: 'Closed',
};

// Where each kind of user reads a conversation.
const USER_LINKS = {
  customer: (id) => `/support?ticket=${id}`,
  vendor: (id) => `/vendor-dashboard/support?ticket=${id}`,
  driver: (id) => `/driver-dashboard/support?ticket=${id}`,
};

const adminLink = (id) => `/admin-dashboard/complaints?complaint=${id}`;

const serializeMessage = (message) => ({
  id: String(message._id),
  from: message.author_role === 'admin' ? 'support' : 'you',
  author_role: message.author_role,
  // Support replies are signed by the team, not an individual admin.
  author_name: message.author_role === 'admin' ? 'Support team' : message.author_name || '',
  body: message.body,
  at: message.at,
});

const serializeTicket = (ticket, { withMessages = false } = {}) => {
  const messages = ticket.messages || [];
  const last = messages[messages.length - 1];
  return {
    id: String(ticket._id),
    reference: ticket.reference,
    subject: ticket.subject,
    category: ticket.category,
    status: ticket.status,
    status_label: STATUS_LABELS[ticket.status] || ticket.status,
    order_id: ticket.related?.order_id ? String(ticket.related.order_id) : null,
    unread: Boolean(ticket.unread_by_user),
    last_message: last ? { from: last.author_role === 'admin' ? 'support' : 'you', body: last.body.slice(0, 140), at: last.at } : null,
    message_count: messages.length,
    created_at: ticket.created_at,
    last_message_at: ticket.last_message_at || ticket.created_at,
    ...(withMessages ? { messages: messages.map(serializeMessage) } : {}),
  };
};

/**
 * Support conversations between users (customers, vendors, delivery workers)
 * and the support team. Each one is a complaint record with a message thread;
 * the admin side works on them from the Complaints/Support page.
 */
class SupportService {
  #user(role, account) {
    return {
      role,
      id: account._id,
      name: account.name || '',
      phone: account.phone_number || account.phone || '',
    };
  }

  async list(role, account) {
    const tickets = await complaintRepository.listByUser(role, account._id);
    return {
      tickets: tickets.map((ticket) => serializeTicket(ticket)),
      unread_count: tickets.filter((ticket) => ticket.unread_by_user).length,
      categories: COMPLAINT_CATEGORIES,
    };
  }

  async create(role, account, body = {}) {
    const user = this.#user(role, account);
    const subject = parseRequiredText(body.subject, { field: 'subject', min: 3, max: maxSubjectLength });
    const message = parseRequiredText(body.message, { field: 'message', min: 2, max: maxMessageLength });
    const category = parseEnum(body.category, COMPLAINT_CATEGORIES, 'category') || 'other';

    // An order the request is about must be the user's own order.
    let orderId = null;
    if (body.order_id) {
      parseObjectId(body.order_id, 'order_id');
      const order = await orderRepository.findById(body.order_id);
      const delivery = order && role === 'driver' ? await deliveryRepository.findByOrderId(order._id) : null;
      const owns =
        order &&
        ((role === 'customer' && String(order.customer_id) === String(user.id)) ||
          (role === 'vendor' && String(order.vendor_id) === String(user.id)) ||
          (role === 'driver' && delivery && String(delivery.driver_id) === String(user.id)));
      if (!owns) throw ApiError.badRequest('That order is not one of yours.', { order_id: 'unknown order' });
      orderId = order._id;
    }

    const now = new Date();
    const ticket = await complaintRepository.create({
      reference: `SUP-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`,
      subject,
      description: message,
      category,
      priority: ['payment', 'refund'].includes(category) ? 'high' : 'medium',
      status: 'open',
      raised_by: { user_id: user.id, role, name: user.name, phone: user.phone },
      related: {
        order_id: orderId,
        vendor_id: role === 'vendor' ? user.id : null,
        driver_id: role === 'driver' ? user.id : null,
      },
      messages: [{ author_role: role, author_id: user.id, author_name: user.name, body: message, at: now }],
      last_message_at: now,
      unread_by_admin: true,
    });

    notificationService
      .notifyAdmin({
        type: 'complaint_opened',
        title: 'New support request',
        body: `${ROLE_NAMES[role]} ${user.name || ''}: ${subject}`.trim(),
        orderId,
        link: adminLink(ticket._id),
        data: { complaint_id: String(ticket._id), reference: ticket.reference },
      })
      .catch(() => null);

    return { ticket: serializeTicket(ticket, { withMessages: true }) };
  }

  async get(role, account, ticketId) {
    parseObjectId(ticketId, 'ticket_id');
    let ticket = await complaintRepository.findForUser(role, account._id, ticketId);
    if (!ticket) throw ApiError.notFound('Support request not found.', 'TICKET_NOT_FOUND');
    if (ticket.unread_by_user) ticket = await complaintRepository.update(ticket._id, { unread_by_user: false });
    return { ticket: serializeTicket(ticket, { withMessages: true }) };
  }

  /** The user writes back. A closed conversation re-opens. */
  async reply(role, account, ticketId, body = {}) {
    parseObjectId(ticketId, 'ticket_id');
    const ticket = await complaintRepository.findForUser(role, account._id, ticketId);
    if (!ticket) throw ApiError.notFound('Support request not found.', 'TICKET_NOT_FOUND');
    const text = parseRequiredText(body.message, { field: 'message', min: 1, max: maxMessageLength });
    const reopen = ['resolved', 'rejected'].includes(ticket.status);

    const updated = await complaintRepository.pushMessage(
      ticket._id,
      { author_role: role, author_id: account._id, author_name: account.name || '', body: text, at: new Date() },
      { unread_by_admin: true, unread_by_user: false, ...(reopen ? { status: 'open', resolved_at: null } : {}) }
    );

    notificationService
      .notifyAdmin({
        type: 'complaint_opened',
        title: reopen ? 'Support request re-opened' : 'New support message',
        body: `${ticket.reference} · ${account.name || ROLE_NAMES[role]}: ${text.slice(0, 100)}`,
        link: adminLink(ticket._id),
        data: { complaint_id: String(ticket._id), reference: ticket.reference },
      })
      .catch(() => null);

    return { ticket: serializeTicket(updated, { withMessages: true }) };
  }

  async unreadCount(role, account) {
    return { unread_count: await complaintRepository.countUnreadForUser(role, account._id) };
  }

  /* ------------------------------ admin side ------------------------------ */

  /** A support team member answers; the user is notified. */
  async adminReply(ticketId, admin, text) {
    const ticket = await complaintRepository.findById(ticketId);
    if (!ticket) throw ApiError.notFound('Complaint not found.', 'COMPLAINT_NOT_FOUND');
    const body = parseRequiredText(text, { field: 'reply', min: 1, max: maxMessageLength });
    const updated = await complaintRepository.pushMessage(
      ticket._id,
      { author_role: 'admin', author_id: admin._id, author_name: admin.name || '', body, at: new Date() },
      { unread_by_user: true, unread_by_admin: false, ...(ticket.status === 'open' ? { status: 'in_review' } : {}) }
    );
    this.notifyUser(updated, 'Support replied', `${ticket.subject}: ${body.slice(0, 140)}`);
    return updated;
  }

  /** Tells the user who raised it (in-app); best-effort. */
  notifyUser(ticket, title, body) {
    const role = ticket.raised_by?.role;
    const userId = ticket.raised_by?.user_id;
    if (!userId || !USER_LINKS[role]) return;
    const link = USER_LINKS[role](ticket._id);
    const data = { complaint_id: String(ticket._id), reference: ticket.reference };
    let sent;
    if (role === 'customer') {
      sent = notificationService.notifyCustomerOrder(userId, { title, body, type: 'support_message', link });
    } else if (role === 'vendor') {
      sent = notificationService.notifyVendor(userId, { type: 'support_message', title, body, link, data });
    } else {
      sent = notificationRepository.createForDriver(userId, {
        type: 'support_message',
        title,
        body,
        data: { ...data, link },
        sms_status: 'skipped',
      });
    }
    Promise.resolve(sent).catch(() => null);
  }
}

const ROLE_NAMES = { customer: 'Customer', vendor: 'Vendor', driver: 'Delivery worker' };

module.exports = new SupportService();
module.exports.STATUS_LABELS = STATUS_LABELS;
