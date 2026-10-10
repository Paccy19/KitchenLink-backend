const ApiError = require('./ApiError');
const config = require('../config');

const PHONE_REGEX = /^\+[1-9]\d{7,14}$/;

function normalizePhone(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw ApiError.badRequest('phone_number is required.', {
      phone_number: 'expected a phone number',
    });
  }
  let phone = String(raw).replace(/[\s\-().]/g, '');
  if (!/^\+?\d{7,15}$/.test(phone)) {
    throw ApiError.badRequest('phone_number is not a valid phone number.', {
      phone_number: 'expected digits with optional country code, e.g. +250788123456 or 0788123456',
    });
  }
  if (phone.startsWith('0')) phone = `+250${phone.slice(1)}`;
  if (!phone.startsWith('+')) phone = `+${phone}`;
  if (!PHONE_REGEX.test(phone)) {
    throw ApiError.badRequest('phone_number is not a valid phone number.', {
      phone_number: 'expected a valid international phone number',
    });
  }
  return phone;
}

function parseName(raw, { required = true } = {}) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) {
    if (!required) return null;
    throw ApiError.badRequest('name is required.', {
      name: 'expected a non-empty string',
    });
  }
  if (name.length < 2 || name.length > 80) {
    throw ApiError.badRequest('name must be between 2 and 80 characters.', {
      name: 'expected 2-80 characters',
    });
  }
  return name;
}

function parseQuantity(raw, { required = false } = {}) {
  if (raw === undefined || raw === null || raw === '') {
    if (!required) return 1;
    throw ApiError.badRequest('quantity is required.', {
      quantity: 'expected an integer between 1 and 99',
    });
  }
  const quantity = Number(raw);
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw ApiError.badRequest('quantity must be a positive integer.', {
      quantity: 'expected an integer between 1 and 99',
    });
  }
  if (quantity > config.limits.cartMaxQuantity) {
    throw ApiError.badRequest(
      `quantity must not exceed ${config.limits.cartMaxQuantity}.`,
      { quantity: `maximum is ${config.limits.cartMaxQuantity}` }
    );
  }
  return quantity;
}

function parsePaymentMethod(raw) {
  const allowed = config.orders.paymentMethods.map((m) => m.code);
  if (!allowed.includes(raw)) {
    throw ApiError.badRequest('payment_method is invalid.', {
      payment_method: `expected one of: ${allowed.join(', ')}`,
    });
  }
  return raw;
}

// MTN (078, 079) and Airtel (073) are the supported Mobile Money networks.
const MOBILE_MONEY_PHONE_REGEX = /^0(78|79|73)\d{7}$/;
const MOBILE_PHONE_REGEX = /^0(72|73|78|79)\d{7}$/;
const CARD_NUMBER_REGEX = /^\d{13,19}$/;
const CARD_EXPIRY_REGEX = /^(0[1-9]|1[0-2])\/\d{2}$/;

function normalizeRwandanPhone(raw) {
  let digits = String(raw ?? '').replace(/[^\d]/g, '');
  if (digits.startsWith('250')) digits = digits.slice(3);
  if (!digits.startsWith('0')) digits = `0${digits}`;
  return digits;
}

/**
 * Validates the payer details captured at checkout. Phone-based methods accept
 * a Rwandan mobile number; cards require a number and MM/YY expiry. The CVV is
 * validated by the client and intentionally never persisted.
 */
function parsePaymentDetails(method, raw) {
  const details = raw && typeof raw === 'object' ? raw : {};

  if (method === 'card') {
    const cardNumber = String(details.card_number ?? '').replace(/[\s-]/g, '');
    if (!CARD_NUMBER_REGEX.test(cardNumber)) {
      throw ApiError.badRequest('payment_details.card_number is invalid.', {
        card_number: 'expected 13-19 digits',
      });
    }
    const cardExpiry = String(details.card_expiry ?? '').trim();
    if (!CARD_EXPIRY_REGEX.test(cardExpiry)) {
      throw ApiError.badRequest('payment_details.card_expiry is invalid.', {
        card_expiry: 'expected MM/YY',
      });
    }
    return { phone: '', card_number: cardNumber, card_expiry: cardExpiry };
  }

  const phone = normalizeRwandanPhone(details.phone);
  const valid =
    method === 'mobile_money'
      ? MOBILE_MONEY_PHONE_REGEX.test(phone)
      : MOBILE_PHONE_REGEX.test(phone);
  if (!valid) {
    throw ApiError.badRequest('payment_details.phone is invalid.', {
      phone:
        method === 'mobile_money'
          ? 'expected an MTN or Airtel number (+25078, +25079 or +25073)'
          : 'expected a valid Rwandan mobile number, e.g. 0788123456',
    });
  }
  return { phone, card_number: '', card_expiry: '' };
}

function parseDeliveryLocation(raw) {
  if (!raw || typeof raw !== 'object') {
    throw ApiError.badRequest('delivery_location is required.', {
      delivery_location: 'expected an object with address, latitude and longitude',
    });
  }
  const address = typeof raw.address === 'string' ? raw.address.trim() : '';
  if (!address || address.length > 200) {
    throw ApiError.badRequest('delivery_location.address is required.', {
      address: 'expected a non-empty string of at most 200 characters',
    });
  }
  const latitude = Number(raw.latitude);
  const longitude = Number(raw.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw ApiError.badRequest('delivery_location latitude and longitude must be numbers.', {
      latitude: 'expected a number between -90 and 90',
      longitude: 'expected a number between -180 and 180',
    });
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw ApiError.badRequest('delivery_location coordinates are out of range.', {
      latitude: 'expected a number between -90 and 90',
      longitude: 'expected a number between -180 and 180',
    });
  }
  const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, 300) : '';
  const neighborhood =
    typeof raw.neighborhood === 'string' ? raw.neighborhood.trim().slice(0, 80) : '';

  return { address, latitude, longitude, note, neighborhood };
}

module.exports = {
  normalizePhone,
  parseName,
  parseQuantity,
  parsePaymentMethod,
  parsePaymentDetails,
  parseDeliveryLocation,
};
