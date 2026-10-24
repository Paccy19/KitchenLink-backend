const { VendorOffer, Order } = require('../models');

class VendorOfferRepository {
  async create(doc) {
    const offer = await VendorOffer.create(doc);
    return offer.toObject();
  }

  /** A vendor's active offers on or after `fromDate` (Kigali "YYYY-MM-DD"), soonest first. */
  async listUpcomingForVendor(vendorId, fromDate) {
    return VendorOffer.find({ vendor_id: vendorId, status: 'active', offer_date: { $gte: fromDate } })
      .sort({ starts_at: 1 })
      .lean();
  }

  async countUpcomingForVendor(vendorId, fromDate) {
    return VendorOffer.countDocuments({ vendor_id: vendorId, status: 'active', offer_date: { $gte: fromDate } });
  }

  async findForVendor(vendorId, offerId) {
    return VendorOffer.findOne({ _id: offerId, vendor_id: vendorId }).lean();
  }

  async cancel(vendorId, offerId) {
    return VendorOffer.findOneAndUpdate(
      { _id: offerId, vendor_id: vendorId, status: 'active' },
      { $set: { status: 'cancelled' } },
      { returnDocument: 'after' }
    ).lean();
  }

  /** Every active offer on or after `fromDate`, with its kitchen, soonest first. */
  async listUpcoming(fromDate, limit = 50) {
    return VendorOffer.find({ status: 'active', offer_date: { $gte: fromDate } })
      .sort({ starts_at: 1 })
      .limit(limit)
      .populate('vendor_id')
      .lean();
  }

  /**
   * Atomically claims an offer's day-before reminder so it is sent once, even
   * across restarts or several servers. Returns the claimed offer or null.
   */
  async claimReminder(offerDate) {
    return VendorOffer.findOneAndUpdate(
      { status: 'active', offer_date: offerDate, reminder_sent_at: null },
      { $set: { reminder_sent_at: new Date() } },
      { returnDocument: 'after' }
    ).lean();
  }

  async markAnnounced(offerId) {
    await VendorOffer.updateOne({ _id: offerId }, { $set: { announced_at: new Date() } });
  }

  /** Customers who have ordered from this kitchen before (its clients). */
  async clientIds(vendorId) {
    return Order.distinct('customer_id', { vendor_id: vendorId, customer_id: { $ne: null } });
  }
}

module.exports = new VendorOfferRepository();
