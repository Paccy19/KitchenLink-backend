const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;

/**
 * One ongoing chat between a customer and a kitchen (vendor), like a
 * messaging app: a single conversation per customer–kitchen pair, not tied to
 * an order. Messages live in ChatMessage. Support (admins) can read chats but
 * never write in them.
 */
const chatConversationSchema = new mongoose.Schema(
  {
    customer_id: { type: ObjectId, ref: 'Customer', required: true },
    vendor_id: { type: ObjectId, ref: 'Vendor', required: true },
    // Preview for the conversation lists.
    last_message_at: { type: Date, default: null },
    last_message_preview: { type: String, default: '' },
    last_message_role: { type: String, enum: ['customer', 'vendor', null], default: null },
    // How many messages each side has not read yet.
    unread_by_customer: { type: Number, default: 0, min: 0 },
    unread_by_vendor: { type: Number, default: 0, min: 0 },
    messages_count: { type: Number, default: 0, min: 0 },
  },
  { timestamps }
);

chatConversationSchema.index({ customer_id: 1, vendor_id: 1 }, { unique: true });
chatConversationSchema.index({ customer_id: 1, last_message_at: -1 });
chatConversationSchema.index({ vendor_id: 1, last_message_at: -1 });
chatConversationSchema.index({ last_message_at: -1 });

module.exports = mongoose.model('ChatConversation', chatConversationSchema);
