const ApiError = require('./ApiError');
const {
  parseObjectId,
  parseOptionalText,
  parseRequiredText,
  parsePriceRwf,
} = require('./vendorValidators');

const badRequest = (message, details) => ApiError.badRequest(message, details);

const parseEnum = (raw, allowed, field) => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = String(raw).trim();
  if (!allowed.includes(value)) {
    throw badRequest(`${field} is invalid.`, {
      [field]: `expected one of: ${allowed.join(', ')}`,
    });
  }
  return value;
};

const parseEnumList = (raw, allowed, field) => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const list = String(raw)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const value of list) {
    if (!allowed.includes(value)) {
      throw badRequest(`${field} contains an invalid value.`, {
        [field]: `expected values from: ${allowed.join(', ')}`,
      });
    }
  }
  return list.length > 0 ? list : undefined;
};

const parseBooleanQuery = (raw, { field, fallback } = {}) => {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;
  const value = String(raw).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  throw badRequest(`${field} must be a boolean.`, {
    [field]: 'expected true or false',
  });
};

const parseDate = (raw, field) => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw badRequest(`${field} must be a valid date.`, {
      [field]: 'expected an ISO date string',
    });
  }
  return date;
};

const parseDateRange = ({ from, to }) => {
  const parsedFrom = parseDate(from, 'from');
  const parsedTo = parseDate(to, 'to');
  if (parsedFrom && parsedTo && parsedFrom > parsedTo) {
    throw badRequest('from must be earlier than to.', {
      from: 'expected a date before "to"',
    });
  }
  return { from: parsedFrom, to: parsedTo };
};

const parsePercentage = (raw, field, { required = false } = {}) => {
  if (raw === undefined || raw === null || raw === '') {
    if (!required) return undefined;
    throw badRequest(`${field} is required.`, {
      [field]: 'expected a number between 0 and 100',
    });
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw badRequest(`${field} must be between 0 and 100.`, {
      [field]: 'expected a number between 0 and 100',
    });
  }
  return Math.round(value * 100) / 100;
};

const parseNonNegativeInt = (raw, field, { required = false, max } = {}) => {
  if (raw === undefined || raw === null || raw === '') {
    if (!required) return undefined;
    throw badRequest(`${field} is required.`, {
      [field]: 'expected a non-negative integer',
    });
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw badRequest(`${field} must be a non-negative integer.`, {
      [field]: 'expected an integer >= 0',
    });
  }
  if (max !== undefined && value > max) {
    throw badRequest(`${field} is too large.`, {
      [field]: `maximum is ${max}`,
    });
  }
  return value;
};

const parseAdminListQuery = (query = {}, { defaultLimit, maxLimit }) => {
  const parsePositiveInt = (value, fallback) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  const limit = Math.min(parsePositiveInt(query.limit, defaultLimit), maxLimit);
  const page = parsePositiveInt(query.page, 1);
  return { limit, page, offset: (page - 1) * limit };
};

module.exports = {
  badRequest,
  parseEnum,
  parseEnumList,
  parseBooleanQuery,
  parseDate,
  parseDateRange,
  parsePercentage,
  parseNonNegativeInt,
  parseAdminListQuery,
  parseObjectId,
  parseOptionalText,
  parseRequiredText,
  parsePriceRwf,
};
