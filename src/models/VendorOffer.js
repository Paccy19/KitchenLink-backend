const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;

/**
 * "Offer Day": a vendor picks a day and announces a deal its clients get on
 * that day. Separate from the "Tomorrow's Special" pre-order announcement.
 *
 * `offer_date` is the Kigali calendar day ("YYYY-MM-DD"); `starts_at` is that
 * day's 00:00 Kigali time, used for sorting and expiry. Clients are alerted
 * when the offer is published (`announced_at`) and again the day before
 * (`reminder_sent_at`).
 */
const vendorOfferSchema = new mongoose.Schema(
  {
    vendor_id: { type: ObjectId, ref: 'Vendor', required: true, index: true },
    title: { type: String, required: true, trim: true },
    details: { type: String, default: '', trim: true },
    offer_date: { type: String, required: true },
    starts_at: { type: Date, required: true },
    status: { type: String, enum: ['active', 'cancelled'], default: 'active' },
    announced_at: { type: Date, default: null },
    reminder_sent_at: { type: Date, default: null },
  },
  { timestamps }
);

vendorOfferSchema.index({ status: 1, starts_at: 1 });
vendorOfferSchema.index({ vendor_id: 1, status: 1, starts_at: 1 });

module.exports = mongoose.model('VendorOffer', vendorOfferSchema);
