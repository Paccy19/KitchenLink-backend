const { ReconciliationCheck } = require('../models');

class ReconciliationRepository {
  async create(doc) {
    const check = await ReconciliationCheck.create(doc);
    return check.toObject();
  }

  async list({ limit = 24 } = {}) {
    return ReconciliationCheck.find({}).sort({ statement_date: -1, created_at: -1 }).limit(limit).lean();
  }
}

module.exports = new ReconciliationRepository();
