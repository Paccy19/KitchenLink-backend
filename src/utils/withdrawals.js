const ApiError = require('./ApiError');
const bankSettingsService = require('../services/bankSettingsService');

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

const NETWORKS = {
  mtn: { label: 'MTN Mobile Money', prefixes: ['078', '079'] },
  airtel: { label: 'Airtel Money', prefixes: ['072', '073'] },
};

/** 'mtn' / 'airtel' from a method label ("MTN Mobile Money", "Airtel Money"), or null. */
const networkOfLabel = (label) => (/airtel/i.test(label) ? 'airtel' : /mtn|momo/i.test(label) ? 'mtn' : null);
const networkOfPhone = (phone) =>
  Object.keys(NETWORKS).find((key) => NETWORKS[key].prefixes.some((prefix) => phone.startsWith(prefix))) || null;

const text = (raw, field, { min = 2, max = 80, label = field } = {}) => {
  const value = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (value.length < min || value.length > max) {
    throw ApiError.badRequest(`Enter the ${label}.`, { [field]: `expected ${min}-${max} characters` });
  }
  return value;
};

/**
 * Where a withdrawal is paid, saved on the withdrawal so the admin knows
 * exactly where to send the money:
 *  - mobile money: `phone` (defaults to the number the account registered
 *    with) on the network of the chosen method (MTN 078/079, Airtel 072/073);
 *  - bank transfer: `bank_name`, `account_name` and `account_number` (digits).
 */
function parsePayoutDestination(method, body = {}, { defaultPhone = '', defaultName = '' } = {}) {
  if (method.code === 'bank_transfer') {
    const accountNumber = String(body.account_number ?? '').replace(/[\s-]/g, '');
    if (!/^\d+$/.test(accountNumber)) {
      throw ApiError.badRequest('Enter the bank account number (digits only).', {
        account_number: 'expected digits only',
      });
    }
    const bankName = text(body.bank_name, 'bank_name', { label: 'bank name', max: 60 });
    // Each bank's account numbers have their own length (set by admins in Settings).
    bankSettingsService.assertAccountNumber(bankName, accountNumber);
    return {
      method_label: 'Bank Transfer',
      bank_name: bankName,
      account_name: text(body.account_name ?? defaultName, 'account_name', { label: 'account holder name', max: 80 }),
      account_number: accountNumber,
    };
  }
  if (method.code !== 'mobile_money') {
    throw ApiError.badRequest('Choose MTN Mobile Money, Airtel Money or a bank transfer.', {
      method: 'expected MTN Mobile Money, Airtel Money or Bank Transfer',
    });
  }
  const phone = parsePayoutPhone(body.phone || defaultPhone, 'phone');
  const chosen = networkOfLabel(method.label);
  const actual = networkOfPhone(phone);
  if (chosen && actual && chosen !== actual) {
    throw ApiError.badRequest(`${phone} is an ${NETWORKS[actual].label} number, not ${NETWORKS[chosen].label}.`, {
      phone: `expected a ${NETWORKS[chosen].prefixes.join('/')} number for ${NETWORKS[chosen].label}`,
    });
  }
  return {
    method_label: NETWORKS[chosen || actual]?.label || method.label,
    bank_name: '',
    account_name: defaultName,
    account_number: phone,
  };
}

function generateReference(prefix = 'WD') {
  return `${prefix}-${new Date().getFullYear()}-${String(Math.floor(1000 + Math.random() * 9000))}`;
}

module.exports = { normalizeMethod, parseAmount, parsePayoutPhone, parsePayoutDestination, generateReference };
