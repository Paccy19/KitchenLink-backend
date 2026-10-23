const mongoose = require('mongoose');
const ApiError = require('../utils/ApiError');
const { Order } = require('../models');
const { orderingRulesFor, vendorTypeLabel } = require('../config/vendorTypes');

// Kitchens work on Kigali days (UTC+2, no daylight saving).
const KIGALI_OFFSET_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Start/end of the Kigali day containing `date`. */
function kigaliDay(date) {
  const start = Math.floor((date.getTime() + KIGALI_OFFSET_MS) / DAY_MS) * DAY_MS - KIGALI_OFFSET_MS;
  return { start: new Date(start), end: new Date(start + DAY_MS) };
}

const kigaliDayKey = (date) => new Date(kigaliDay(date).start.getTime() + KIGALI_OFFSET_MS).toISOString().slice(0, 10);

const formatLead = (minutes) => {
  if (minutes >= 24 * 60 && minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${minutes} minutes`;
};

/**
 * Type-based ordering rules (see config/vendorTypes.js RULES): whether a
 * kitchen takes orders for now, how far ahead, how many a day, the smallest
 * order and the biggest basket. Enforced at checkout.
 */
class VendorOrderingService {
  rules(vendor) {
    return orderingRulesFor(vendor);
  }

  /** Paid, not-cancelled orders served on the Kigali day containing `date`. */
  async ordersOnDay(vendorId, date = new Date()) {
    const { start, end } = kigaliDay(date);
    return Order.countDocuments({
      vendor_id: new mongoose.Types.ObjectId(String(vendorId)),
      payment_status: 'paid',
      status: { $ne: 'cancelled' },
      $or: [
        { scheduled_for: { $gte: start, $lt: end } },
        { scheduled_for: null, created_at: { $gte: start, $lt: end } },
      ],
    });
  }

  /** Rules plus today's bookings, for the storefront and the dashboard. */
  async summary(vendor) {
    const rules = this.rules(vendor);
    const today = rules.daily_order_limit ? await this.ordersOnDay(vendor._id) : null;
    return {
      ...rules,
      vendor_type_label: vendorTypeLabel(rules.vendor_type),
      orders_today: today,
      fully_booked_today: rules.daily_order_limit ? today >= rules.daily_order_limit : false,
    };
  }

  /**
   * Throws when an order breaks the kitchen's type rules. `scheduledFor` is
   * the slot (null for immediate orders); `itemCount` is the total quantity.
   */
  async assertOrderAllowed(vendor, { orderType, scheduledFor, subtotal, itemCount }) {
    const rules = this.rules(vendor);
    const label = vendorTypeLabel(rules.vendor_type);

    if (orderType === 'immediate' && !rules.order_now) {
      throw ApiError.conflict(
        `${vendor.name || 'This kitchen'} is a ${label} and takes advance orders only. Schedule your order at least ${formatLead(rules.min_lead_minutes)} ahead.`,
        'ADVANCE_ORDERS_ONLY'
      );
    }

    // Scheduled slots must respect the type's notice and how far ahead it
    // plans. Pre-orders use the kitchen's own announced time, so they skip this.
    if (orderType === 'scheduled' && scheduledFor) {
      const now = Date.now();
      if (scheduledFor.getTime() < now + rules.min_lead_minutes * 60 * 1000) {
        throw ApiError.badRequest(
          `${label} kitchens need at least ${formatLead(rules.min_lead_minutes)} notice. Pick a later time.`,
          { scheduled_for: `expected at least ${rules.min_lead_minutes} minutes from now` }
        );
      }
      if (scheduledFor.getTime() > now + rules.max_days_ahead * DAY_MS) {
        throw ApiError.badRequest(
          `${label} kitchens take orders up to ${rules.max_days_ahead} day${rules.max_days_ahead === 1 ? '' : 's'} ahead. Pick an earlier day.`,
          { scheduled_for: `expected within the next ${rules.max_days_ahead} days` }
        );
      }
    }

    if (rules.min_order_rwf && subtotal < rules.min_order_rwf) {
      throw ApiError.conflict(
        `${vendor.name || 'This kitchen'} takes orders from ${rules.min_order_rwf.toLocaleString()} RWF. Add ${(rules.min_order_rwf - subtotal).toLocaleString()} RWF more.`,
        'BELOW_MINIMUM_ORDER'
      );
    }

    if (rules.max_items_per_order && itemCount > rules.max_items_per_order) {
      throw ApiError.conflict(
        `${label} kitchens take up to ${rules.max_items_per_order} dishes per order. For bigger orders, choose a Caterer or a Restaurant.`,
        'TOO_MANY_ITEMS'
      );
    }

    if (rules.daily_order_limit) {
      const day = scheduledFor || new Date();
      const booked = await this.ordersOnDay(vendor._id, day);
      if (booked >= rules.daily_order_limit) {
        const isToday = kigaliDayKey(day) === kigaliDayKey(new Date());
        throw ApiError.conflict(
          `${vendor.name || 'This kitchen'} is fully booked ${isToday ? 'today' : 'that day'} (${rules.daily_order_limit} orders a day). Schedule your order for another day.`,
          'KITCHEN_FULLY_BOOKED'
        );
      }
    }
  }

  /** The kitchen changes its own daily limit / minimum order within its type's range. */
  parseSettings(vendor, body = {}) {
    const rules = this.rules(vendor);
    const settings = {
      daily_order_limit: vendor.ordering_settings?.daily_order_limit ?? null,
      min_order_rwf: vendor.ordering_settings?.min_order_rwf ?? null,
    };
    const parseInRange = (raw, range, field) => {
      if (raw === null || raw === '') return null; // back to the type default
      const value = Number(raw);
      if (!Number.isInteger(value) || value < range[0] || value > range[1]) {
        throw ApiError.badRequest(`${field} must be between ${range[0]} and ${range[1]}.`, {
          [field]: `expected a whole number from ${range[0]} to ${range[1]}`,
        });
      }
      return value;
    };
    if (body.daily_order_limit !== undefined) {
      if (!rules.limit_range) {
        throw ApiError.badRequest(`${vendorTypeLabel(rules.vendor_type)} kitchens have no daily order limit.`, {
          daily_order_limit: 'not used for this vendor type',
        });
      }
      settings.daily_order_limit = parseInRange(body.daily_order_limit, rules.limit_range, 'daily_order_limit');
    }
    if (body.min_order_rwf !== undefined) {
      settings.min_order_rwf = parseInRange(body.min_order_rwf, rules.min_order_range, 'min_order_rwf');
    }
    return settings;
  }
}

module.exports = new VendorOrderingService();
module.exports.kigaliDay = kigaliDay;
