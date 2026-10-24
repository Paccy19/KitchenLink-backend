const { ChatConversation, ChatMessage } = require('../models');

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SIDE_FIELD = { customer: 'customer_id', vendor: 'vendor_id' };
const UNREAD_FIELD = { customer: 'unread_by_customer', vendor: 'unread_by_vendor' };

class ChatRepository {
  /** The customer–kitchen conversation, created the first time it is needed. */
  async findOrCreate(customerId, vendorId) {
    return ChatConversation.findOneAndUpdate(
      { customer_id: customerId, vendor_id: vendorId },
      { $setOnInsert: { customer_id: customerId, vendor_id: vendorId } },
      { upsert: true, returnDocument: 'after' }
    ).lean();
  }

  async findById(conversationId) {
    return ChatConversation.findById(conversationId).lean();
  }

  /** A conversation that belongs to this customer / vendor (null otherwise). */
  async findForSide(side, accountId, conversationId) {
    return ChatConversation.findOne({ _id: conversationId, [SIDE_FIELD[side]]: accountId }).lean();
  }

  /** One side's conversations that have at least one message, newest first. */
  async listForSide(side, accountId, { limit = 50 } = {}) {
    return ChatConversation.find({ [SIDE_FIELD[side]]: accountId, messages_count: { $gt: 0 } })
      .sort({ last_message_at: -1 })
      .limit(limit)
      .populate('customer_id', 'name profile_image_url')
      .populate('vendor_id', 'name vendor_type profile_image_url banner_image_url is_open is_active')
      .lean();
  }

  async unreadTotal(side, accountId) {
    const [row] = await ChatConversation.aggregate([
      { $match: { [SIDE_FIELD[side]]: accountId } },
      { $group: { _id: null, total: { $sum: `$${UNREAD_FIELD[side]}` } } },
    ]);
    return row?.total || 0;
  }

  /** Adds a message and updates the preview and the other side's unread count. */
  async addMessage(conversation, { role, authorId, body }) {
    const message = await ChatMessage.create({
      conversation_id: conversation._id,
      author_role: role,
      author_id: authorId,
      body,
    });
    const other = role === 'customer' ? 'vendor' : 'customer';
    const updated = await ChatConversation.findByIdAndUpdate(
      conversation._id,
      {
        $set: {
          last_message_at: message.created_at,
          last_message_preview: body.slice(0, 120),
          last_message_role: role,
          // Writing in a chat means you have read it.
          [UNREAD_FIELD[role]]: 0,
        },
        $inc: { [UNREAD_FIELD[other]]: 1, messages_count: 1 },
      },
      { returnDocument: 'after' }
    ).lean();
    return { message: message.toObject(), conversation: updated };
  }

  async markRead(side, conversationId) {
    return ChatConversation.findByIdAndUpdate(conversationId, { $set: { [UNREAD_FIELD[side]]: 0 } }, { returnDocument: 'after' }).lean();
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
