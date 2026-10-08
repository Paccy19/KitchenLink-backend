const { OtpCode } = require('../models');

class OtpRepository {
  async create({ phoneNumber, code, name, expiresAt }) {
    return OtpCode.create({
      phone_number: phoneNumber,
      code,
      name: name || undefined,
      expires_at: expiresAt,
    });
  }

  async findLatestActive(phoneNumber) {
    return OtpCode.findOne({
      phone_number: phoneNumber,
      consumed_at: null,
      expires_at: { $gt: new Date() },
    }).sort({ created_at: -1 });
  }

  async findLatestAny(phoneNumber) {
    return OtpCode.findOne({ phone_number: phoneNumber }).sort({ created_at: -1 });
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

  async lastSentAt(phoneNumber) {
    const latest = await OtpCode.findOne({ phone_number: phoneNumber })
      .sort({ created_at: -1 })
      .select('created_at')
      .lean();
    return latest?.created_at ?? null;
  }
}

module.exports = new OtpRepository();
