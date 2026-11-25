const { OtpCode } = require('../models');
const { hashOtp } = require('../utils/otpHash');

/**
 * `context` narrows a lookup to what the code authorizes: a string, or a list
 * of strings (e.g. ['login', ''] — '' also matches codes saved before
 * contexts existed). null means any context.
 */
const contextFilter = (context) => {
  if (context === null || context === undefined) return {};
  const list = Array.isArray(context) ? context : [context];
  return list.includes('')
    ? { $or: [{ context: { $in: list } }, { context: { $exists: false } }] }
    : { context: { $in: list } };
};

const purposeFilter = (purpose) =>
  purpose === 'customer' ? { $or: [{ purpose }, { purpose: { $exists: false } }] } : { purpose };

const and = (...filters) => {
  const parts = filters.filter((filter) => Object.keys(filter).length);
  return parts.length ? { $and: parts } : {};
};

class OtpRepository {
  /** Stores a new code — only its keyed hash, never the code itself. */
  async create({ phoneNumber, purpose = 'customer', context = '', channel = 'sms', code, name, registrationPhone, expiresAt }) {
    return OtpCode.create({
      phone_number: phoneNumber,
      purpose,
      context,
      channel,
      code_hash: hashOtp(code),
      name: name || undefined,
      registration_phone: registrationPhone || undefined,
      expires_at: expiresAt,
    });
  }

  async findLatestActive(phoneNumber, purpose = 'customer', context = null) {
    return OtpCode.findOne({
      phone_number: phoneNumber,
      ...and(purposeFilter(purpose), contextFilter(context)),
      consumed_at: null,
      expires_at: { $gt: new Date() },
    }).sort({ created_at: -1 });
  }

  async findLatestAny(phoneNumber, purpose = 'customer', context = null) {
    return OtpCode.findOne({ phone_number: phoneNumber, ...and(purposeFilter(purpose), contextFilter(context)) })
      .sort({ created_at: -1 });
  }

  /** A new code replaces the earlier ones for the same use: they stop working. */
  async invalidateActive(phoneNumber, purpose = 'customer', context = null) {
    await OtpCode.updateMany(
      {
        phone_number: phoneNumber,
        ...and(purposeFilter(purpose), contextFilter(context)),
        consumed_at: null,
        expires_at: { $gt: new Date() },
      },
      { $set: { consumed_at: new Date() } }
    );
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
