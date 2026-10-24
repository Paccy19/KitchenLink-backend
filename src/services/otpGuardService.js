const config = require('../config');
const ApiError = require('../utils/ApiError');
const { OtpCode, OtpGuard } = require('../models');

const DAY_MS = 24 * 60 * 60 * 1000;

const minutesText = (minutes) =>
  minutes >= 60 ? `${Math.round(minutes / 60)} hour${Math.round(minutes / 60) === 1 ? '' : 's'}` : `${minutes} minutes`;

/**
 * Brute-force protection for 6-digit sign-in codes, per phone number and kind
 * of code (customer / vendor / driver / admin):
 *  - each guess is counted atomically, so a burst of parallel guesses can't
 *    get more than `otpMaxAttempts` tries at one code, and a code works once;
 *  - `maxFailures` wrong codes within a day lock the phone out (no new codes,
 *    no guesses) for 30 min, then 2 h, then 24 h; a correct code resets it;
 *  - at most `maxSendsPerDay` codes a day, which also caps SMS costs.
 */
class OtpGuardService {
  #key(phone, purpose) {
    return `${purpose}:${phone}`;
  }

  async #guard(phone, purpose) {
    return OtpGuard.findOne({ key: this.#key(phone, purpose) }).lean();
  }

  #lockedError(until, purpose) {
    const minutes = Math.max(1, Math.ceil((new Date(until).getTime() - Date.now()) / 60000));
    if (purpose === 'admin-login') {
      return ApiError.tooMany(
        `Too many failed sign-ins for this account. Try again in ${minutesText(minutes)}.`,
        'LOGIN_LOCKED',
        { retry_after_minutes: minutes }
      );
    }
    return ApiError.tooMany(
      `Too many incorrect codes for this phone number. Try again in ${minutesText(minutes)}.`,
      'OTP_LOCKED',
      { retry_after_minutes: minutes }
    );
  }

  /**
   * Password sign-ins use the same lockout (purpose 'admin-login', keyed by
   * email): counts a failed attempt and throws the lockout when it is reached.
   */
  async recordFailedAttempt(id, purpose) {
    const lockedUntil = await this.#recordFailure(id, purpose);
    if (lockedUntil) throw this.#lockedError(lockedUntil, purpose);
  }

  /** A successful sign-in clears the failure count and any lockout level. */
  async clearFailures(id, purpose) {
    await OtpGuard.updateOne(
      { key: this.#key(id, purpose) },
      { $set: { failures: 0, failures_since: null, lock_level: 0, locked_until: null } }
    );
  }

  /** Throws while this phone is locked out. */
  async assertNotLocked(phone, purpose) {
    const guard = await this.#guard(phone, purpose);
    if (guard?.locked_until && new Date(guard.locked_until) > new Date()) throw this.#lockedError(guard.locked_until, purpose);
  }

  /** Before sending a code: not locked, and under the daily cap. Counts the send. */
  async beforeSend(phone, purpose) {
    const guard = await this.#guard(phone, purpose);
    const now = new Date();
    if (guard?.locked_until && new Date(guard.locked_until) > now) throw this.#lockedError(guard.locked_until, purpose);

    const { maxSendsPerDay: userCap, adminMaxSendsPerDay } = config.auth.otpLockout;
    const maxSendsPerDay = purpose === 'admin' ? adminMaxSendsPerDay : userCap;
    const updated = await this.#bump(this.#key(phone, purpose), 'sends', 'sends_since', now);
    if (updated.sends > maxSendsPerDay) {
      throw ApiError.tooMany(
        `Too many codes requested for this phone number today (${maxSendsPerDay}). Try again tomorrow.`,
        'OTP_DAILY_LIMIT'
      );
    }
  }

  /**
   * Adds one to a counter that restarts after a day, in a single atomic
   * update (parallel requests can't overwrite each other's counts).
   */
  async #bump(key, field, sinceField, now) {
    const stale = {
      $or: [{ $eq: [{ $ifNull: [`$${sinceField}`, null] }, null] }, { $lt: [`$${sinceField}`, new Date(now.getTime() - DAY_MS)] }],
    };
    return OtpGuard.findOneAndUpdate(
      { key },
      [
        {
          $set: {
            [field]: { $cond: [stale, 1, { $add: [{ $ifNull: [`$${field}`, 0] }, 1] }] },
            [sinceField]: { $cond: [stale, now, `$${sinceField}`] },
          },
        },
      ],
      { upsert: true, returnDocument: 'after', updatePipeline: true }
    ).lean();
  }

  /**
   * Checks `rawCode` against `otp` (the latest active code). Throws on a wrong
   * code (counting it, and locking the phone out when there are too many);
   * returns normally when it is right, after using the code up.
   */
  async check(otp, rawCode, phone, purpose) {
    const max = config.auth.otpMaxAttempts;
    // Claim one try atomically: parallel requests can't all see "0 tries used".
    const claimed = await OtpCode.findOneAndUpdate(
      { _id: otp._id, consumed_at: null, attempts: { $lt: max } },
      { $inc: { attempts: 1 } },
      { new: true }
    ).lean();
    if (!claimed) {
      await OtpCode.updateOne({ _id: otp._id }, { $set: { consumed_at: new Date() } });
      throw ApiError.tooMany('Too many incorrect attempts. Request a new code.', 'OTP_TOO_MANY_ATTEMPTS');
    }

    if (claimed.code !== rawCode) {
      const lockedUntil = await this.#recordFailure(phone, purpose);
      if (lockedUntil) {
        await OtpCode.updateOne({ _id: otp._id }, { $set: { consumed_at: new Date() } });
        throw this.#lockedError(lockedUntil, purpose);
      }
      throw new ApiError(400, 'OTP_INVALID', 'Incorrect code.', {
        code: 'incorrect code',
        attempts_remaining: Math.max(max - claimed.attempts, 0),
      });
    }

    // Right code: use it up (once only, even if two requests race).
    const used = await OtpCode.findOneAndUpdate(
      { _id: otp._id, consumed_at: null },
      { $set: { consumed_at: new Date() } }
    ).lean();
    if (!used) throw new ApiError(400, 'OTP_NOT_FOUND', 'This code was already used. Request a new one.');
    await OtpGuard.updateOne(
      { key: this.#key(phone, purpose) },
      { $set: { failures: 0, failures_since: null, lock_level: 0, locked_until: null } }
    );
  }

  /** Counts a wrong code; returns the lock end when this one locks the phone out. */
  async #recordFailure(phone, purpose) {
    const { lockMinutes } = config.auth.otpLockout;
    const maxFailures = purpose === 'admin-login' ? config.auth.otpLockout.adminLoginMaxFailures : config.auth.otpLockout.maxFailures;
    const key = this.#key(phone, purpose);
    const now = new Date();
    const updated = await this.#bump(key, 'failures', 'failures_since', now);
    if (updated.failures < maxFailures) return null;

    // Only one of several parallel failures turns the count into a lockout.
    const level = (updated.lock_level || 0) + 1;
    const minutes = lockMinutes[Math.min(level, lockMinutes.length) - 1];
    const lockedUntil = new Date(now.getTime() + minutes * 60000);
    const locked = await OtpGuard.findOneAndUpdate(
      { key, failures: { $gte: maxFailures } },
      { $set: { lock_level: level, locked_until: lockedUntil, failures: 0, failures_since: null } },
      { returnDocument: 'after' }
    ).lean();
    if (!locked) {
      const current = await OtpGuard.findOne({ key }).lean();
      return current?.locked_until && new Date(current.locked_until) > now ? current.locked_until : null;
    }
    const what = purpose === 'admin-login' ? 'admin sign-in' : `${purpose} sign-in codes`;
    console.warn(`[security] ${what} locked for ${phone.slice(0, -4)}**** for ${minutes} min`);
    return lockedUntil;
  }
}

module.exports = new OtpGuardService();
