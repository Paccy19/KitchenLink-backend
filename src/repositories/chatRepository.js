const { ChatConversation, ChatMessage } = require('../models');

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SIDE_FIELD = { customer: 'customer_id', vendor: 'vendor_id' };
const UNREAD_FIELD = { customer: 'unread_by_customer', vendor: 'unread_by_vendor' };

class ChatRepository {
  /** The customer–kitchen conversation, created the first time it is needed. */
  async findOrCreate(customerId, vendorId) {
    return ChatConversation.findOneAndUpdate(
      { customer_id: customerId, vendor_id: vendorId, special_delivery_request_id: null },
      { $setOnInsert: { customer_id: customerId, vendor_id: vendorId, special_delivery_request_id: null } },
      { upsert: true, returnDocument: 'after' }
    ).lean();
  }

  async findById(conversationId) {
    return ChatConversation.findById(conversationId).lean();
  }

  /** The negotiation chat of a special delivery request, created the first time. */
  async findOrCreateForRequest(request) {
    return ChatConversation.findOneAndUpdate(
      { customer_id: request.customer_id, vendor_id: request.vendor_id, special_delivery_request_id: request._id },
      {
        $setOnInsert: {
          customer_id: request.customer_id,
          vendor_id: request.vendor_id,
          special_delivery_request_id: request._id,
        },
      },
      { upsert: true, returnDocument: 'after' }
    ).lean();
  }

  /** A conversation that belongs to this customer / vendor (null otherwise). */
  async findForSide(side, accountId, conversationId) {
    // General chats only: negotiation chats are reached through their request.
    return ChatConversation.findOne({
      _id: conversationId,
      [SIDE_FIELD[side]]: accountId,
      special_delivery_request_id: null,
    }).lean();
  }

  /** One side's conversations that have at least one message, newest first. */
  async listForSide(side, accountId, { limit = 50 } = {}) {
    return ChatConversation.find({ [SIDE_FIELD[side]]: accountId, messages_count: { $gt: 0 }, special_delivery_request_id: null })
      .sort({ last_message_at: -1 })
      .limit(limit)
      .populate('customer_id', 'name profile_image_url')
      .populate('vendor_id', 'name vendor_type profile_image_url banner_image_url is_open is_active')
      .lean();
  }

  async unreadTotal(side, accountId) {
    const [row] = await ChatConversation.aggregate([
      { $match: { [SIDE_FIELD[side]]: accountId, special_delivery_request_id: null } },
      { $group: { _id: null, total: { $sum: `$${UNREAD_FIELD[side]}` } } },
    ]);
    return row?.total || 0;
  }

  /** Adds a message and updates the preview and the other side's unread count. */
  async addMessage(
    conversation,
    { role, authorId = null, body = '', kind = 'text', attachmentUrl = null, location = null, quotationId = null, preview = null }
  ) {
    const message = await ChatMessage.create({
      conversation_id: conversation._id,
      kind,
      author_role: role,
      author_id: authorId,
      body,
      attachment_url: attachmentUrl,
      location,
      quotation_id: quotationId,
    });
    const previewText = (preview ?? body).slice(0, 120);
    if (role === 'system') {
      // Platform notes: both sides have something new to read.
      const updated = await ChatConversation.findByIdAndUpdate(
        conversation._id,
        {
          $set: { last_message_at: message.created_at, last_message_preview: previewText, last_message_role: 'system' },
          $inc: { unread_by_customer: 1, unread_by_vendor: 1, messages_count: 1 },
        },
        { returnDocument: 'after' }
      ).lean();
      return { message: message.toObject(), conversation: updated };
    }
    const other = role === 'customer' ? 'vendor' : 'customer';
    const readField = role === 'customer' ? 'customer_read_at' : 'vendor_read_at';
    const updated = await ChatConversation.findByIdAndUpdate(
      conversation._id,
      {
        $set: {
          last_message_at: message.created_at,
          last_message_preview: previewText,
          last_message_role: role,
          // Writing in a chat means you have read it.
          [UNREAD_FIELD[role]]: 0,
          [readField]: message.created_at,
        },
        $inc: { [UNREAD_FIELD[other]]: 1, messages_count: 1 },
      },
      { returnDocument: 'after' }
    ).lean();
    return { message: message.toObject(), conversation: updated };
  }

  async markRead(side, conversationId) {
    const readField = side === 'customer' ? 'customer_read_at' : 'vendor_read_at';
    return ChatConversation.findByIdAndUpdate(
      conversationId,
      { $set: { [UNREAD_FIELD[side]]: 0, [readField]: new Date() } },
      { returnDocument: 'after' }
    ).lean();
  }

  /**
   * Messages, newest page first. `before` (a date) loads older messages;
   * `after` returns only messages newer than that date (for polling).
   */
  async listMessages(conversationId, { before = null, after = null, limit = 50 } = {}) {
    const filter = { conversation_id: conversationId };
    if (after) filter.created_at = { $gt: after };
    else if (before) filter.created_at = { $lt: before };
    const rows = await ChatMessage.find(filter).sort({ created_at: -1 }).limit(limit).lean();
    return rows.reverse();
  }

  /* -------------------------------- admin -------------------------------- */

  /** Every chat with messages, newest first; `search` matches the customer or kitchen name. */
  async adminList({ customerIds = null, vendorIds = null, limit, offset }) {
    const filter = { messages_count: { $gt: 0 } };
    if (customerIds || vendorIds) {
      filter.$or = [];
      if (customerIds) filter.$or.push({ customer_id: { $in: customerIds } });
      if (vendorIds) filter.$or.push({ vendor_id: { $in: vendorIds } });
    }
    const [items, total] = await Promise.all([
      ChatConversation.find(filter)
        .sort({ last_message_at: -1 })
        .skip(offset)
        .limit(limit)
        .populate('customer_id', 'name phone_number')
        .populate('vendor_id', 'name vendor_type phone')
        .lean(),
      ChatConversation.countDocuments(filter),
    ]);
    return { items, total };
  }

  async adminFind(conversationId) {
    return ChatConversation.findById(conversationId)
      .populate('customer_id', 'name phone_number')
      .populate('vendor_id', 'name vendor_type phone')
      .lean();
  }
}

module.exports = new ChatRepository();
module.exports.escapeRegex = escapeRegex;
