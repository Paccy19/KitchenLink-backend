const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;

const MESSAGE_KINDS = ['text', 'image', 'location', 'quotation', 'system'];

/**
 * One message in a customer–kitchen chat (see ChatConversation).
 *   text      a written message (`body`)
 *   image     a photo (`attachment_url`, optional caption in `body`)
 *   location  a shared map point (`location`)
 *   quotation a kitchen's formal quotation was submitted (`quotation_id`)
 *   system    a status note written by the platform (author_role 'system')
 * General chats only use text.
 */
function bodyRequired() {
  return !this.kind || this.kind === 'text';
}

const chatMessageSchema = new mongoose.Schema(
  {
    conversation_id: { type: ObjectId, ref: 'ChatConversation', required: true },
    kind: { type: String, enum: MESSAGE_KINDS, default: 'text' },
    author_role: { type: String, enum: ['customer', 'vendor', 'system'], required: true },
    author_id: { type: ObjectId, default: null },
    body: { type: String, required: bodyRequired, trim: true, maxlength: 1000, default: '' },
    attachment_url: { type: String, default: null },
    location: {
      type: new mongoose.Schema(
        { latitude: Number, longitude: Number, label: { type: String, default: '' } },
        { _id: false }
      ),
      default: null,
    },
    quotation_id: { type: ObjectId, ref: 'DeliveryQuotation', default: null },
  },
  { timestamps }
);

chatMessageSchema.index({ conversation_id: 1, created_at: -1 });

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
module.exports.MESSAGE_KINDS = MESSAGE_KINDS;
