const { OtpCode } = require('../models');

class OtpRepository {
  async create({ phoneNumber, purpose = 'customer', context = '', code, name, expiresAt }) {
    return OtpCode.create({
      phone_number: phoneNumber,
      purpose,
      context,
      code,
      name: name || undefined,
      expires_at: expiresAt,
    });
  }

  async findLatestActive(phoneNumber, purpose = 'customer', context = null) {
    const purposeFilter = purpose === 'customer'
      ? { $or: [{ purpose }, { purpose: { $exists: false } }] }
      : { purpose };
    return OtpCode.findOne({
      phone_number: phoneNumber,
      ...purposeFilter,
      ...(context ? { context } : {}),
      consumed_at: null,
      expires_at: { $gt: new Date() },
    }).sort({ created_at: -1 });
  }

  async findLatestAny(phoneNumber, purpose = 'customer') {
    const purposeFilter = purpose === 'customer'
      ? { $or: [{ purpose }, { purpose: { $exists: false } }] }
      : { purpose };
    return OtpCode.findOne({ phone_number: phoneNumber, ...purposeFilter })
      .sort({ created_at: -1 });
  }

  /** A code whose SMS never left: removed, so it can't be used or block a retry. */
  async remove(otpId) {
    await OtpCode.deleteOne({ _id: otpId });
  }

  async incrementAttempts(otpId) {
    await OtpCode.updateOne({ _id: otpId }, { $inc: { attempts: 1 } });
  }

  async consume(otpId) {
    await OtpCode.updateOne(
      { _id: otpId },
      { $set: { consumed_at: new Date() } }
    );
  }

  async countRecent(phoneNumber, since) {
    return OtpCode.countDocuments({
      phone_number: phoneNumber,
      created_at: { $gte: since },
    });
  }

  async lastSentAt(phoneNumber, context = null) {
    const latest = await OtpCode.findOne({ phone_number: phoneNumber, ...(context ? { context } : {}) })
      .sort({ created_at: -1 })
      .select('created_at')
      .lean();
    return latest?.created_at ?? null;
  }
}

module.exports = new OtpRepository();
