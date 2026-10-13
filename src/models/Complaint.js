const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const COMPLAINT_STATUSES = ['open', 'in_review', 'resolved', 'rejected'];
const COMPLAINT_PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const COMPLAINT_CATEGORIES = [
  'order',
  'delivery',
  'payment',
  'refund',
  'app',
  'vendor',
  'driver',
  'account',
  'other',
];

const complaintSchema = new mongoose.Schema(
  {
    reference: { type: String, required: true, unique: true, index: true },
    subject: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    category: {
      type: String,
      enum: COMPLAINT_CATEGORIES,
      default: 'other',
    },
    priority: {
      type: String,
      enum: COMPLAINT_PRIORITIES,
      default: 'medium',
    },
    status: {
      type: String,
      enum: COMPLAINT_STATUSES,
      default: 'open',
      index: true,
    },
    // Reporter snapshot (a customer/vendor/driver may be deleted later).
    raised_by: {
      user_id: { type: mongoose.Schema.Types.ObjectId, default: null },
      role: {
        type: String,
        enum: ['customer', 'vendor', 'driver', 'admin', 'guest'],
        default: 'guest',
      },
      name: { type: String, default: '' },
      phone: { type: String, default: '' },
    },
    // Optional links to the entities the complaint is about.
    related: {
      order_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
      vendor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: null },
      driver_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver', default: null },
    },
    assigned_to: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    // The conversation the user sees: their messages and support's replies.
    // (`notes` below are internal to the support team.)
    messages: [
      {
        author_role: {
          type: String,
          enum: ['customer', 'vendor', 'driver', 'admin'],
          required: true,
        },
        author_id: { type: mongoose.Schema.Types.ObjectId, default: null },
        author_name: { type: String, default: '' },
        body: { type: String, required: true },
        at: { type: Date, default: Date.now },
      },
    ],
    last_message_at: { type: Date, default: null },
    // Who has something new to read.
    unread_by_user: { type: Boolean, default: false },
    unread_by_admin: { type: Boolean, default: false },
    notes: [
      {
        author_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
        author_name: { type: String, default: 'Admin' },
        body: { type: String, default: '' },
        at: { type: Date, default: Date.now },
      },
    ],
    resolved_at: { type: Date, default: null },
    resolved_by: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    deleted_at: { type: Date, default: null },
  },
  { timestamps }
);

complaintSchema.index({ status: 1, created_at: -1 });
complaintSchema.index({ category: 1, created_at: -1 });
complaintSchema.index({ 'raised_by.role': 1, 'raised_by.user_id': 1, last_message_at: -1 });

module.exports = mongoose.model('Complaint', complaintSchema);
module.exports.COMPLAINT_STATUSES = COMPLAINT_STATUSES;
module.exports.COMPLAINT_PRIORITIES = COMPLAINT_PRIORITIES;
module.exports.COMPLAINT_CATEGORIES = COMPLAINT_CATEGORIES;
