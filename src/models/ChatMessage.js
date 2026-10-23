const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;

/** One message in a customer–kitchen chat (see ChatConversation). */
const chatMessageSchema = new mongoose.Schema(
  {
    conversation_id: { type: ObjectId, ref: 'ChatConversation', required: true },
    author_role: { type: String, enum: ['customer', 'vendor'], required: true },
    author_id: { type: ObjectId, required: true },
    body: { type: String, required: true, trim: true, maxlength: 1000 },
  },
  { timestamps }
);

chatMessageSchema.index({ conversation_id: 1, created_at: -1 });

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
