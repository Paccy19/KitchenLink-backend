const { PayoutDestination } = require('../models');

class PayoutDestinationRepository {
  async create(doc) {
    const destination = await PayoutDestination.create(doc);
    return destination.toObject();
  }

  async findById(destinationId) {
    return PayoutDestination.findById(destinationId).lean();
  }

  async listActive() {
    return PayoutDestination.find({ status: 'active' }).sort({ created_at: 1 }).lean();
  }

  async remove(destinationId) {
    return PayoutDestination.findOneAndUpdate(
      { _id: destinationId, status: 'active' },
      { $set: { status: 'removed', removed_at: new Date() } },
      { new: true }
    ).lean();
  }
}

module.exports = new PayoutDestinationRepository();
