const mongoose = require('mongoose');
const timestamps = require('./timestamps');

/** Guests waiting for a free table. */
const waitlistEntrySchema = new mongoose.Schema(
  {
    vendor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, default: '', trim: true },
    party_size: { type: Number, min: 1, max: 200, required: true },
    notes: { type: String, default: '', trim: true },
    quoted_minutes: { type: Number, min: 0, default: null },
    status: { type: String, enum: ['waiting', 'seated', 'left'], default: 'waiting' },
    session_id: { type: mongoose.Schema.Types.ObjectId, ref: 'TableSession', default: null },
    added_by: { type: { type: String, default: null }, id: { type: String, default: null }, name: { type: String, default: '' } },
    seated_at: { type: Date, default: null },
  },
  { timestamps }
);

waitlistEntrySchema.index({ vendor_id: 1, status: 1, created_at: 1 });

module.exports = mongoose.model('WaitlistEntry', waitlistEntrySchema);
