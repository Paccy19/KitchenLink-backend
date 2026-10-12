const ApiError = require('./ApiError');

/** Shared request parsing for vendor and driver withdrawals. */

const METHOD_ALIASES = [
  { match: /momo|mtn|mobile|airtel/i, code: 'mobile_money' },
  { match: /bank|transfer/i, code: 'bank_transfer' },
  { match: /cash/i, code: 'cash' },
];

function normalizeMethod(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return { code: 'mobile_money', label: 'MTN Mobile Money' };
  const alias = METHOD_ALIASES.find((entry) => entry.match.test(value));
  const code = alias?.code ?? 'other';
  const label = value.length <= 40 ? value : value.slice(0, 40);
  return { code, label };
}

function parseAmount(raw) {
  const amount = Number(raw);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw ApiError.badRequest('amount_rwf must be a positive whole number.', {
      amount_rwf: 'expected an integer greater than 0',
    });
  }
  return amount;
}

// MTN (078, 079) and Airtel (072, 073) Rwandan mobile money numbers.
const MOMO_PHONE_REGEX = /^07[2389]\d{7}$/;

/** Normalizes a Rwandan mobile money number to the local 07XXXXXXXX form. */
function parsePayoutPhone(raw, field = 'phone') {
  let digits = String(raw ?? '').replace(/[^\d]/g, '');
  if (digits.startsWith('250')) digits = digits.slice(3);
  if (!digits.startsWith('0')) digits = `0${digits}`;
  if (!MOMO_PHONE_REGEX.test(digits)) {
    throw ApiError.badRequest(`${field} must be a valid MTN or Airtel mobile money number.`, {
      [field]: 'expected a Rwandan number like 0788123456',
    });
  }
  return digits;
}

function generateReference(prefix = 'WD') {
  return `${prefix}-${new Date().getFullYear()}-${String(Math.floor(1000 + Math.random() * 9000))}`;
}

module.exports = { normalizeMethod, parseAmount, parsePayoutPhone, generateReference };
