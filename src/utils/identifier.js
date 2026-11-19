const ApiError = require('./ApiError');
const { normalizePhone } = require('./validators');
const { parseEmail } = require('./vendorValidators');

/**
 * The one sign-in field accepts an email address or a phone number; the
 * server decides which it is (never the browser). Anything with an "@" is an
 * email, everything else must be a Rwandan mobile number.
 *   → { type: 'email', value: 'name@example.com' }
 *   → { type: 'phone', value: '+250788123456' }
 */
function parseIdentifier(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw ApiError.badRequest('Enter your phone number or email address.', { identifier: 'required' });
  }
  const text = String(raw).trim();
  if (!text) throw ApiError.badRequest('Enter your phone number or email address.', { identifier: 'required' });
  if (text.includes('@')) {
    try {
      return { type: 'email', value: parseEmail(text) };
    } catch {
      throw ApiError.badRequest('Enter a valid email address, e.g. name@example.com.', { identifier: 'invalid email' });
    }
  }
  try {
    return { type: 'phone', value: normalizePhone(text) };
  } catch {
    throw ApiError.badRequest('Enter a valid phone number (07XXXXXXXX or +2507XXXXXXXX) or email address.', {
      identifier: 'expected a Rwandan phone number or an email address',
    });
  }
}

/** The identifier from a request body: `identifier`, or the older field names. */
const identifierFrom = (body = {}, ...legacyFields) => {
  const raw = body.identifier ?? legacyFields.map((field) => body[field]).find((value) => value !== undefined && value !== null && value !== '');
  return parseIdentifier(raw);
};

/** Every way one Rwandan number may have been stored by older code (normalized first). */
const phoneVariants = (normalized) => {
  const local = `0${normalized.slice(4)}`;
  return [normalized, normalized.slice(1), local];
};

/**
 * Names compared the way people write them: case, accents, repeated spaces and
 * word order don't matter ("  UWASE  aline" = "Aline Uwase"), but every word
 * must be there: "Aline" ≠ "Aline Uwase", and sharing one word is not a match.
 */
const nameKey = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
const sameName = (a, b) => Boolean(nameKey(a)) && nameKey(a) === nameKey(b);

const maskPhone = (phone = '') => (phone ? `${'•'.repeat(Math.max(0, phone.length - 3))}${phone.slice(-3)}` : '');
/** "aline.uwase@gmail.com" → "al•••••••@gmail.com" */
const maskEmail = (email = '') => {
  const [user, domain] = String(email).split('@');
  if (!domain) return '';
  return `${user.slice(0, 2)}${'•'.repeat(Math.max(3, user.length - 2))}@${domain}`;
};
const maskIdentifier = ({ type, value }) => (type === 'email' ? maskEmail(value) : maskPhone(value));

module.exports = { parseIdentifier, identifierFrom, phoneVariants, nameKey, sameName, maskPhone, maskEmail, maskIdentifier };
