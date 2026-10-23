const mongoose = require('mongoose');
const config = require('../config');
const ApiError = require('../utils/ApiError');
const { parseObjectId, parseAdminListQuery } = require('../utils/adminValidators');
const { vendorTypeLabel } = require('../config/vendorTypes');
const { ChatConversation, Customer, Vendor } = require('../models');
const chatRepository = require('../repositories/chatRepository');
const vendorRepository = require('../repositories/vendorRepository');
const notificationService = require('./notificationService');

const { escapeRegex } = chatRepository;
const MESSAGE_MAX_LENGTH = 1000;

const parseBody = (raw) => {
  const body = typeof raw === 'string' ? raw.trim().replace(/\n{3,}/g, '\n\n') : '';
  if (!body) {
    throw ApiError.badRequest('Write a message first.', { body: 'expected a non-empty message' });
  }
  if (body.length > MESSAGE_MAX_LENGTH) {
    throw ApiError.badRequest(`Messages can be at most ${MESSAGE_MAX_LENGTH} characters.`, {
      body: `expected at most ${MESSAGE_MAX_LENGTH} characters`,
    });
  }
  return body;
};

const parseDate = (raw, field) => {
  if (raw === undefined || raw === null || raw === '') return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw ApiError.badRequest(`${field} must be a date.`, { [field]: 'expected an ISO date' });
  }
  return date;
};

const id = (value) => (value && value._id ? String(value._id) : value ? String(value) : null);

/** The person on the other side of the chat, as one side sees them. */
const counterpart = (conversation, side) => {
  if (side === 'customer') {
    const vendor = conversation.vendor_id || {};
    return {
      id: id(vendor),
      name: vendor.name || 'Kitchen',
      avatar_url: vendor.profile_image_url || vendor.banner_image_url || null,
      vendor_type: vendor.vendor_type || null,
      vendor_type_label: vendor.vendor_type ? vendorTypeLabel(vendor.vendor_type) : null,
      is_open: vendor.is_open ?? null,
    };
  }
  const customer = conversation.customer_id || {};
  return { id: id(customer), name: customer.name || 'Customer', avatar_url: customer.profile_image_url || null };
};

const serializeConversation = (conversation, side) => ({
  id: String(conversation._id),
  with: counterpart(conversation, side),
  last_message_at: conversation.last_message_at,
  last_message_preview: conversation.last_message_preview || '',
  last_message_mine: conversation.last_message_role === side,
  unread_count: side === 'customer' ? conversation.unread_by_customer : conversation.unread_by_vendor,
});

const serializeMessage = (message, side = null) => ({
  id: String(message._id),
  author_role: message.author_role,
  mine: side ? message.author_role === side : false,
  body: message.body,
  created_at: message.created_at,
});

// Shown on both sides of every chat.
const PRIVACY_NOTE = 'Chats are kept so our support team can help if there is a problem. Never share passwords or payment codes.';

class ChatService {
  /* --------------------------- customer + vendor --------------------------- */

  async list(side, account) {
    const conversations = await chatRepository.listForSide(side, account._id);
    return {
      conversations: conversations.map((conversation) => serializeConversation(conversation, side)),
      unread_count: conversations.reduce(
        (sum, c) => sum + (side === 'customer' ? c.unread_by_customer : c.unread_by_vendor),
        0
      ),
    };
  }

  async unreadCount(side, account) {
    return { unread_count: await chatRepository.unreadTotal(side, account._id) };
  }

  /**
   * Customer: opens (or creates) their chat with a kitchen, from the kitchen
   * page or an order. Only kitchens customers can see can be messaged.
   */
  async openWithVendor(customer, vendorId) {
    parseObjectId(vendorId, 'vendor_id');
    const vendor = await vendorRepository.findActiveById(vendorId);
    if (!vendor) throw ApiError.notFound('This kitchen is not available.', 'VENDOR_NOT_FOUND');
    const conversation = await chatRepository.findOrCreate(customer._id, vendor._id);
    return this.get('customer', customer, String(conversation._id));
  }

  /** One conversation with its latest messages (and marks it read for this side). */
  async get(side, account, conversationId, query = {}) {
    const conversation = await this.#own(side, account, conversationId);
    const messages = await chatRepository.listMessages(conversation._id, {
      before: parseDate(query.before, 'before'),
      after: parseDate(query.after, 'after'),
      limit: Math.min(Number(query.limit) || 50, 100),
    });
    const unread = side === 'customer' ? conversation.unread_by_customer : conversation.unread_by_vendor;
    if (unread > 0) await chatRepository.markRead(side, conversation._id);
    const populated = await this.#populated(conversation._id);
    return {
      conversation: { ...serializeConversation(populated, side), unread_count: 0 },
      messages: messages.map((message) => serializeMessage(message, side)),
      has_more: !query.after && messages.length === Math.min(Number(query.limit) || 50, 100),
      privacy_note: PRIVACY_NOTE,
    };
  }

  async send(side, account, conversationId, body = {}) {
    const text = parseBody(body.body ?? body.message);
    const conversation = await this.#own(side, account, conversationId);
    if (side === 'customer') {
      // A kitchen that was suspended or removed can't be messaged any more.
      const vendor = await vendorRepository.findActiveById(conversation.vendor_id);
      if (!vendor) throw ApiError.conflict('This kitchen is not available any more.', 'VENDOR_NOT_AVAILABLE');
    }

    const { message, conversation: updated } = await chatRepository.addMessage(conversation, {
      role: side,
      authorId: account._id,
      body: text,
    });

    // Tell the other side once per batch of unread messages, not on every message.
    const otherUnread = side === 'customer' ? updated.unread_by_vendor : updated.unread_by_customer;
    if (otherUnread === 1) this.#notify(side, account, updated, text);

    return { message: serializeMessage(message, side) };
  }

  async markRead(side, account, conversationId) {
    const conversation = await this.#own(side, account, conversationId);
    await chatRepository.markRead(side, conversation._id);
    return { ok: true };
  }

  /* ------------------------------ admin (read) ----------------------------- */

  async adminList(query = {}) {
    const { limit, page, offset } = parseAdminListQuery(query, {
      defaultLimit: config.admin.limits.listDefault,
      maxLimit: config.admin.limits.listMax,
    });
    let customerIds = null;
    let vendorIds = null;
    const search = typeof query.search === 'string' ? query.search.trim() : '';
    if (search) {
      const regex = new RegExp(escapeRegex(search), 'i');
      const [customers, vendors] = await Promise.all([
        Customer.find({ $or: [{ name: regex }, { phone_number: regex }] }, { _id: 1 }).limit(200).lean(),
        Vendor.find({ $or: [{ name: regex }, { phone: regex }] }, { _id: 1 }).limit(200).lean(),
      ]);
      customerIds = customers.map((row) => row._id);
      vendorIds = vendors.map((row) => row._id);
    }
    if (query.vendor_id) vendorIds = [new mongoose.Types.ObjectId(parseObjectId(query.vendor_id, 'vendor_id'))];
    if (query.customer_id) customerIds = [new mongoose.Types.ObjectId(parseObjectId(query.customer_id, 'customer_id'))];

    const { items, total } = await chatRepository.adminList({ customerIds, vendorIds, limit, offset });
    return {
      items: items.map((conversation) => this.#serializeAdmin(conversation)),
      total,
      page,
      limit,
    };
  }

  async adminGet(conversationId, query = {}) {
    parseObjectId(conversationId, 'conversation_id');
    const conversation = await chatRepository.adminFind(conversationId);
    if (!conversation) throw ApiError.notFound('Chat not found.', 'CHAT_NOT_FOUND');
    const limit = Math.min(Number(query.limit) || 100, 200);
    const messages = await chatRepository.listMessages(conversation._id, {
      before: parseDate(query.before, 'before'),
      limit,
    });
    return {
      conversation: this.#serializeAdmin(conversation),
      messages: messages.map((message) => serializeMessage(message)),
      has_more: messages.length === limit,
    };
  }

  /* -------------------------------- helpers -------------------------------- */

  async #own(side, account, conversationId) {
    parseObjectId(conversationId, 'conversation_id');
    const conversation = await chatRepository.findForSide(side, account._id, conversationId);
    if (!conversation) throw ApiError.notFound('Chat not found.', 'CHAT_NOT_FOUND');
    return conversation;
  }

  async #populated(conversationId) {
    return ChatConversation.findById(conversationId)
      .populate('customer_id', 'name profile_image_url')
      .populate('vendor_id', 'name vendor_type profile_image_url banner_image_url is_open is_active')
      .lean();
  }

  #serializeAdmin(conversation) {
    const customer = conversation.customer_id || {};
    const vendor = conversation.vendor_id || {};
    return {
      id: String(conversation._id),
      customer: { id: id(customer), name: customer.name || 'Customer', phone: customer.phone_number || '' },
      vendor: {
        id: id(vendor),
        name: vendor.name || 'Kitchen',
        phone: vendor.phone || '',
        vendor_type: vendor.vendor_type || null,
        vendor_type_label: vendor.vendor_type ? vendorTypeLabel(vendor.vendor_type) : null,
      },
      messages_count: conversation.messages_count || 0,
      last_message_at: conversation.last_message_at,
      last_message_preview: conversation.last_message_preview || '',
      last_message_role: conversation.last_message_role,
      created_at: conversation.created_at,
    };
  }

  #notify(side, account, conversation, text) {
    const preview = text.length > 90 ? `${text.slice(0, 87)}…` : text;
    if (side === 'customer') {
      notificationService
        .notifyVendor(conversation.vendor_id, {
          type: 'chat_message',
          title: `New message from ${account.name || 'a customer'}`,
          body: preview,
          link: `/vendor-dashboard/messages?chat=${conversation._id}`,
          data: { conversation_id: String(conversation._id) },
        })
        .catch(() => null);
    } else {
      notificationService
        .notifyCustomers([conversation.customer_id], {
          type: 'chat_message',
          title: `New message from ${account.name || 'the kitchen'}`,
          body: preview,
          link: `/messages?chat=${conversation._id}`,
          data: { conversation_id: String(conversation._id) },
        })
        .catch(() => null);
    }
  }
}

module.exports = new ChatService();
module.exports.MESSAGE_MAX_LENGTH = MESSAGE_MAX_LENGTH;
