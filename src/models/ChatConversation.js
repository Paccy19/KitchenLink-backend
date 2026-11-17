const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;

/**
 * A chat between a customer and a kitchen (vendor). Two kinds:
 *  - the general chat: one ongoing conversation per customer–kitchen pair,
 *    not tied to an order (special_delivery_request_id null);
 *  - a special delivery negotiation: one per SpecialDeliveryRequest, opened
 *    when the kitchen accepts to negotiate. It is only reachable through
 *    /special-deliveries (its rules follow the request's status).
 * Messages live in ChatMessage. Support (admins) can read chats but never
 * write in them.
 */
const chatConversationSchema = new mongoose.Schema(
  {
    customer_id: { type: ObjectId, ref: 'Customer', required: true },
    vendor_id: { type: ObjectId, ref: 'Vendor', required: true },
    special_delivery_request_id: { type: ObjectId, ref: 'SpecialDeliveryRequest', default: null },
    // Preview for the conversation lists.
    last_message_at: { type: Date, default: null },
    last_message_preview: { type: String, default: '' },
    last_message_role: { type: String, enum: ['customer', 'vendor', 'system', null], default: null },
    // How many messages each side has not read yet.
    unread_by_customer: { type: Number, default: 0, min: 0 },
    unread_by_vendor: { type: Number, default: 0, min: 0 },
    // When each side last read the chat (read receipts on messages).
    customer_read_at: { type: Date, default: null },
    vendor_read_at: { type: Date, default: null },
    messages_count: { type: Number, default: 0, min: 0 },
  },
  { timestamps }
);

// One general chat per pair (request id null) and one chat per request. This
// replaces the older unique { customer_id, vendor_id } index, which start-up
// drops (scripts/migrateChatIndexes.js).
chatConversationSchema.index(
  { customer_id: 1, vendor_id: 1, special_delivery_request_id: 1 },
  { unique: true, name: 'one_chat_per_pair_or_request' }
);
chatConversationSchema.index({ customer_id: 1, last_message_at: -1 });
chatConversationSchema.index({ vendor_id: 1, last_message_at: -1 });
chatConversationSchema.index({ last_message_at: -1 });

module.exports = mongoose.model('ChatConversation', chatConversationSchema);
