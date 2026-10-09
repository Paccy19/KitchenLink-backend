const mongoose = require('mongoose');
const config = require('../config');
const ApiError = require('./ApiError');
const { VENDOR_TYPES, LEGACY_VENDOR_TYPES } = require('../models/Vendor');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];
const PAYOUT_METHODS = ['mobile_money', 'bank_transfer', 'cash', 'other'];
const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

function badRequest(message, details) {
  return ApiError.badRequest(message, details);
}

function parseEmail(raw) {
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!email || !EMAIL_REGEX.test(email) || email.length > 254) {
    throw badRequest('email is required and must be valid.', {
      email: 'expected a valid email address',
    });
  }
  return email;
}

function parsePassword(raw, { field = 'password' } = {}) {
  const password = typeof raw === 'string' ? raw : '';
  if (password.length < 8 || password.length > 128) {
    throw badRequest(`${field} must be between 8 and 128 characters.`, {
      [field]: 'expected 8-128 characters',
    });
  }
  return password;
}

function parseObjectId(raw, field) {
  if (!mongoose.isValidObjectId(raw)) {
    throw badRequest(`${field} must be a valid id.`, {
      [field]: 'expected a valid MongoDB id',
    });
  }
  return raw;
}

function parseOptionalText(raw, { field, max = 500 } = {}) {
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  if (text.length > max) {
    throw badRequest(`${field} must be at most ${max} characters.`, {
      [field]: `maximum length is ${max}`,
    });
  }
  return text;
}

function parseRequiredText(raw, { field, min = 2, max = 120 } = {}) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text.length < min || text.length > max) {
    throw badRequest(`${field} must be between ${min} and ${max} characters.`, {
      [field]: `expected ${min}-${max} characters`,
    });
  }
  return text;
}

function parsePriceRwf(raw, { field = 'price_rwf', required = true } = {}) {
  if (raw === undefined || raw === null || raw === '') {
    if (!required) return undefined;
    throw badRequest(`${field} is required.`, {
      [field]: 'expected an integer number of Rwandan francs (>= 0)',
    });
  }
  const price = Number(raw);
  if (!Number.isInteger(price) || price < 0) {
    throw badRequest(`${field} must be a whole number of Rwandan francs.`, {
      [field]: 'expected an integer >= 0',
    });
  }
  if (price > 100000000) {
    throw badRequest(`${field} is unrealistically high.`, {
      [field]: 'maximum is 100,000,000 RWF',
    });
  }
  return price;
}

function parsePrepTime(raw, { required = false } = {}) {
  if (raw === undefined || raw === null || raw === '') {
    if (!required) return undefined;
    throw badRequest('preparation_time_minutes is required.', {
      preparation_time_minutes: 'expected an integer between 0 and 600',
    });
  }
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 600) {
    throw badRequest(
      'preparation_time_minutes must be an integer between 0 and 600.',
      { preparation_time_minutes: 'expected an integer between 0 and 600' }
    );
  }
  return minutes;
}

function parseBooleanValue(raw, { field, fallback } = {}) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;
  const value = String(raw).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  throw badRequest(`${field} must be a boolean.`, {
    [field]: 'expected true or false',
  });
}

function parseMenuOptions(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;

  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch (error) {
      throw badRequest('options must be valid JSON.', {
        options: 'expected a JSON array of options',
      });
    }
  }
  if (!Array.isArray(list)) {
    throw badRequest('options must be an array.', {
      options: 'expected an array',
    });
  }
  if (list.length > config.vendor.limits.optionsMax) {
    throw badRequest(
      `A menu item can have at most ${config.vendor.limits.optionsMax} options.`,
      { options: `maximum is ${config.vendor.limits.optionsMax}` }
    );
  }

  return list.map((option, index) => {
    if (!option || typeof option !== 'object') {
      throw badRequest('Each option must be an object.', {
        [`options[${index}]`]: 'expected { name, additional_price_rwf, group_name }',
      });
    }
    return {
      name: parseRequiredText(option.name, {
        field: `options[${index}].name`,
        min: 1,
        max: 60,
      }),
      group_name:
        parseOptionalText(option.group_name, {
          field: `options[${index}].group_name`,
          max: 40,
        }) || 'Options',
      additional_price_rwf:
        parsePriceRwf(option.additional_price_rwf, {
          field: `options[${index}].additional_price_rwf`,
          required: false,
        }) ?? 0,
      is_available:
        parseBooleanValue(option.is_available, {
          field: `options[${index}].is_available`,
          fallback: true,
        }) ?? true,
      sort_order:
        option.sort_order === undefined || option.sort_order === null
          ? index
          : Number.isFinite(Number(option.sort_order))
            ? Number(option.sort_order)
            : index,
    };
  });
}

const MENU_SORTS = ['newest', 'oldest', 'name', 'price_asc', 'price_desc'];
const ORDER_SORTS = ['newest', 'oldest', 'total_asc', 'total_desc'];

function parseSort(raw, allowed) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (!allowed.includes(raw)) {
    throw badRequest('sort value is invalid.', {
      sort: `expected one of: ${allowed.join(', ')}`,
    });
  }
  return raw;
}

function parseVendorOrderStatus(raw) {
  if (!config.vendor.orderStatuses.includes(raw)) {
    throw badRequest('status is invalid.', {
      status: `expected one of: ${config.vendor.orderStatuses.join(', ')}`,
    });
  }
  return raw;
}

function parseVendorType(raw) {
  const allowed = [...VENDOR_TYPES, ...LEGACY_VENDOR_TYPES];
  if (!allowed.includes(raw)) {
    throw badRequest('vendor_type is invalid.', {
      vendor_type: `expected one of: ${VENDOR_TYPES.join(', ')}`,
    });
  }
  return raw;
}

/** Accepts either an already-parsed object/array or a JSON string. */
function parseJsonField(raw, field) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw badRequest(`${field} must be valid JSON.`, {
      [field]: 'expected a JSON object or array',
    });
  }
}

function parseOperatingHours(raw) {
  const value = parseJsonField(raw, 'operating_hours');
  if (value === undefined) {
    throw badRequest('operating_hours is required.', {
      operating_hours: 'expected a weekly schedule',
    });
  }

  let entries = value;
  if (!Array.isArray(value)) {
    if (typeof value !== 'object' || value === null) {
      throw badRequest('operating_hours must be an array or object.', {
        operating_hours: 'expected an array of { day, open_time, close_time }',
      });
    }
    entries = Object.entries(value).map(([day, schedule]) => ({
      day,
      ...(schedule && typeof schedule === 'object' ? schedule : {}),
    }));
  }

  const normalized = entries.map((entry, index) => {
    const day = String(entry.day ?? entry.day_name ?? '').trim().toLowerCase();
    if (!DAYS.includes(day)) {
      throw badRequest('operating_hours day is invalid.', {
        [`operating_hours[${index}].day`]: `expected one of: ${DAYS.join(', ')}`,
      });
    }
    const isClosed = parseBooleanValue(entry.is_closed ?? entry.closed, {
      field: `operating_hours[${index}].is_closed`,
      fallback: false,
    });
    const open = String(entry.open_time ?? entry.open ?? '').trim();
    const close = String(entry.close_time ?? entry.close ?? '').trim();
    if (!isClosed && (!TIME_REGEX.test(open) || !TIME_REGEX.test(close))) {
      throw badRequest('operating_hours times must be HH:MM.', {
        [`operating_hours[${index}]`]:
          'open_time and close_time are required (HH:MM) unless is_closed',
      });
    }
    return {
      day,
      open_time: isClosed ? '' : open,
      close_time: isClosed ? '' : close,
      is_closed: isClosed,
    };
  });

  if (normalized.length === 0) {
    throw badRequest('operating_hours must have at least one day.', {
      operating_hours: 'add at least one entry',
    });
  }
  return normalized;
}

function parsePaymentInformation(raw) {
  const value = parseJsonField(raw, 'payment_information');
  if (value === undefined || typeof value !== 'object' || value === null) {
    throw badRequest('payment_information is required.', {
      payment_information: 'expected an object with payout details',
    });
  }

  const pick = (field, max = 120) =>
    value[field] === undefined || value[field] === null
      ? ''
      : String(value[field]).trim().slice(0, max);

  const payoutMethod = pick('payout_method', 30).toLowerCase();
  if (payoutMethod && !PAYOUT_METHODS.includes(payoutMethod)) {
    throw badRequest('payment_information.payout_method is invalid.', {
      'payment_information.payout_method': `expected one of: ${PAYOUT_METHODS.join(', ')}`,
    });
  }

  const info = {
    payout_method: payoutMethod,
    account_name: pick('account_name'),
    account_number: pick('account_number', 60),
    bank_name: pick('bank_name'),
    mobile_money_number: pick('mobile_money_number', 30),
  };

  const hasDetails =
    info.payout_method ||
    info.account_name ||
    info.account_number ||
    info.mobile_money_number;
  if (!hasDetails) {
    throw badRequest('payment_information must include payout details.', {
      payment_information: 'provide a payout method and account details',
    });
  }
  return info;
}

/** Food categories as valid MongoDB ids or category names. */
function parseFoodCategoryTokens(raw) {
  const value = parseJsonField(raw, 'food_categories');
  if (value === undefined) {
    throw badRequest('food_categories is required.', {
      food_categories: 'expected one or more category ids or names',
    });
  }

  let list = value;
  if (typeof value === 'string') {
    list = value.split(',').map((token) => token.trim()).filter(Boolean);
  }
  if (!Array.isArray(list)) {
    throw badRequest('food_categories must be an array.', {
      food_categories: 'expected an array of category ids or names',
    });
  }

  const tokens = list
    .map((entry) => {
      if (entry && typeof entry === 'object') {
        return String(entry.id ?? entry.name ?? entry.category_id ?? '').trim();
      }
      return String(entry ?? '').trim();
    })
    .filter(Boolean);

  if (tokens.length === 0) {
    throw badRequest('food_categories must not be empty.', {
      food_categories: 'provide at least one category',
    });
  }
  return tokens;
}

/** Verification documents supplied as JSON (uploaded files are added separately). */
function parseVerificationDocuments(raw) {
  const value = parseJsonField(raw, 'verification_documents');
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw badRequest('verification_documents must be an array.', {
      verification_documents: 'expected an array of { label, url }',
    });
  }
  return value.map((doc, index) => {
    const url = doc && typeof doc === 'object' ? String(doc.url ?? '').trim() : '';
    if (!url) {
      throw badRequest('verification_documents url is required.', {
        [`verification_documents[${index}].url`]: 'expected a document URL',
      });
    }
    return {
      label:
        doc && doc.label !== undefined
          ? String(doc.label).trim().slice(0, 120)
          : `Document ${index + 1}`,
      url,
    };
  });
}

module.exports = {
  parseEmail,
  parsePassword,
  parseObjectId,
  parseOptionalText,
  parseRequiredText,
  parsePriceRwf,
  parsePrepTime,
  parseBooleanValue,
  parseMenuOptions,
  parseSort,
  parseVendorOrderStatus,
  parseVendorType,
  parseJsonField,
  parseOperatingHours,
  parsePaymentInformation,
  parseFoodCategoryTokens,
  parseVerificationDocuments,
  MENU_SORTS,
  ORDER_SORTS,
};
