const config = require('../config');
const ApiError = require('../utils/ApiError');
const { serializeVendorSpecial } = require('../utils/serializers');
const vendorRepository = require('../repositories/vendorRepository');

const { special: specialConfig } = config.orders;

const parseDate = (raw, field) => {
  const value = typeof raw === 'string' || raw instanceof Date ? new Date(raw) : null;
  if (!value || Number.isNaN(value.getTime())) {
    throw ApiError.badRequest(`${field} is invalid.`, {
      [field]: 'expected an ISO date-time',
    });
  }
  return value;
};

class VendorSpecialService {
  get(vendor) {
    return { special: serializeVendorSpecial(vendor.special) };
  }

  /**
   * Publishes (or replaces) a vendor's "Tomorrow's Special" announcement. The
   * cutoff must be in the future and the delivery time at/after the cutoff.
   */
  async upsert(vendor, body = {}) {
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (text.length < 2 || text.length > specialConfig.textMax) {
      throw ApiError.badRequest('special.text is required.', {
        text: `expected 2-${specialConfig.textMax} characters`,
      });
    }

    const cutoffAt = parseDate(body.cutoff_at, 'cutoff_at');
    const deliveryAt = parseDate(body.delivery_at, 'delivery_at');

    const now = Date.now();
    if (cutoffAt.getTime() <= now) {
      throw ApiError.badRequest('special.cutoff_at must be in the future.', {
        cutoff_at: 'the order-before time has already passed',
      });
    }
    if (deliveryAt.getTime() < cutoffAt.getTime()) {
      throw ApiError.badRequest(
        'special.delivery_at must be at or after the cutoff time.',
        { delivery_at: 'expected a time at or after cutoff_at' }
      );
    }
    const maxAhead = specialConfig.maxDaysAhead * 24 * 60 * 60 * 1000;
    if (deliveryAt.getTime() > now + maxAhead) {
      throw ApiError.badRequest('special.delivery_at is too far ahead.', {
        delivery_at: `expected within the next ${specialConfig.maxDaysAhead} days`,
      });
    }

    const updated = await vendorRepository.update(vendor._id, {
      special: {
        text,
        cutoff_at: cutoffAt,
        delivery_at: deliveryAt,
        is_active: true,
        updated_at: new Date(),
      },
    });

    return { special: serializeVendorSpecial(updated.special) };
  }

  async clear(vendor) {
    const updated = await vendorRepository.update(vendor._id, {
      special: {
        text: '',
        cutoff_at: null,
        delivery_at: null,
        is_active: false,
        updated_at: new Date(),
      },
    });
    return { special: serializeVendorSpecial(updated.special) };
  }
}

module.exports = new VendorSpecialService();
