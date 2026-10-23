const ApiError = require('../utils/ApiError');
const { BankSettings } = require('../models');

// Any bank without a known length (and "other" banks): 6–30 digits.
const GENERAL = { min: 6, max: 30 };

/**
 * Starting list. Lengths are only filled in where a real account number was
 * found (Bank of Kigali: 14 digits, e.g. 00094-0651934-37; I&M: 16 digits,
 * e.g. 00010-5044380-06-81). Admins confirm or set the others in Settings.
 */
const DEFAULT_BANKS = [
  { name: 'Bank of Kigali', digits_min: 14, digits_max: 14 },
  { name: 'I&M Bank Rwanda', digits_min: 16, digits_max: 16 },
  { name: 'Equity Bank Rwanda', digits_min: null, digits_max: null },
  { name: 'BPR Bank Rwanda', digits_min: null, digits_max: null },
  { name: 'Access Bank Rwanda', digits_min: null, digits_max: null },
  { name: 'Ecobank Rwanda', digits_min: null, digits_max: null },
  { name: 'NCBA Bank Rwanda', digits_min: null, digits_max: null },
  { name: 'GT Bank Rwanda', digits_min: null, digits_max: null },
  { name: 'Bank of Africa Rwanda', digits_min: null, digits_max: null },
  { name: 'Cogebanque', digits_min: null, digits_max: null },
  { name: 'Zigama CSS', digits_min: null, digits_max: null },
  { name: 'Urwego Bank', digits_min: null, digits_max: null },
];

const clean = (bank) => ({
  name: bank.name,
  digits_min: bank.digits_min ?? null,
  digits_max: bank.digits_max ?? null,
});

/** Banks and their account-number lengths, kept in memory and refreshed on change. */
class BankSettingsService {
  #banks = DEFAULT_BANKS.map(clean);
  #updatedAt = null;

  async load() {
    const row = await BankSettings.findOne({ key: 'primary' }).lean();
    if (row?.banks?.length) {
      this.#banks = row.banks.map(clean);
      this.#updatedAt = row.updated_at ?? null;
    }
    return this.list();
  }

  list() {
    return {
      banks: this.#banks.map((bank) => ({ ...bank, ...this.lengthFor(bank.name) })),
      general: GENERAL,
      updated_at: this.#updatedAt,
    };
  }

  /** { min, max, exact } digits allowed for this bank (the general rule for unknown banks). */
  lengthFor(bankName) {
    const bank = this.#banks.find((entry) => entry.name.toLowerCase() === String(bankName || '').trim().toLowerCase());
    const min = bank?.digits_min ?? GENERAL.min;
    const max = bank?.digits_max ?? GENERAL.max;
    return { min, max, exact: Boolean(bank?.digits_min) && bank.digits_min === bank.digits_max };
  }

  /** Throws a clear error when the account number doesn't have this bank's length. */
  assertAccountNumber(bankName, digits) {
    const { min, max, exact } = this.lengthFor(bankName);
    if (digits.length >= min && digits.length <= max) return;
    const rule = exact ? `${min} digits` : `${min}–${max} digits`;
    throw ApiError.badRequest(`${bankName} account numbers have ${rule}. You entered ${digits.length}.`, {
      account_number: `expected ${rule}`,
    });
  }

  async update(admin, body = {}) {
    if (!Array.isArray(body.banks) || body.banks.length === 0) {
      throw ApiError.badRequest('Add at least one bank.', { banks: 'expected a list of banks' });
    }
    const seen = new Set();
    const banks = body.banks.map((raw, index) => {
      const name = typeof raw?.name === 'string' ? raw.name.trim().replace(/\s+/g, ' ') : '';
      if (name.length < 2 || name.length > 60) {
        throw ApiError.badRequest(`Bank ${index + 1} needs a name (2–60 characters).`, { banks: 'invalid name' });
      }
      if (seen.has(name.toLowerCase())) {
        throw ApiError.badRequest(`${name} is listed twice.`, { banks: 'duplicate bank' });
      }
      seen.add(name.toLowerCase());
      const num = (value) => (value === '' || value === null || value === undefined ? null : Number(value));
      const min = num(raw.digits_min);
      const max = num(raw.digits_max ?? raw.digits_min);
      for (const value of [min, max]) {
        if (value !== null && (!Number.isInteger(value) || value < 4 || value > 34)) {
          throw ApiError.badRequest(`${name}: the number of digits must be a whole number from 4 to 34.`, { banks: 'invalid length' });
        }
      }
      if ((min === null) !== (max === null) || (min !== null && min > max)) {
        throw ApiError.badRequest(`${name}: the smallest length can't be more than the largest.`, { banks: 'invalid length' });
      }
      return { name, digits_min: min, digits_max: max };
    });

    const previous = this.list();
    await BankSettings.findOneAndUpdate(
      { key: 'primary' },
      { $set: { banks, updated_by: admin?._id || null } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    await this.load();
    return { previous, current: this.list() };
  }
}

module.exports = new BankSettingsService();
