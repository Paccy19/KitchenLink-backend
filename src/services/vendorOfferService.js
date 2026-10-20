const mongoose = require('mongoose');
const config = require('../config');
const ApiError = require('../utils/ApiError');
const { distanceFromCoords } = require('../utils/geo');
const { serializeVendorCard } = require('../utils/serializers');
const vendorOfferRepository = require('../repositories/vendorOfferRepository');
const vendorRepository = require('../repositories/vendorRepository');
const notificationService = require('./notificationService');

const { offerDays } = config.orders;
const KIGALI_OFFSET_MS = config.vendor.timezoneOffsetHours * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Kigali calendar day ("YYYY-MM-DD") of a moment, shifted by `addDays`. */
const kigaliDay = (date = new Date(), addDays = 0) =>
  new Date(date.getTime() + KIGALI_OFFSET_MS + addDays * DAY_MS).toISOString().slice(0, 10);

/** 00:00 Kigali time of a "YYYY-MM-DD" day, as a UTC Date. */
const kigaliMidnight = (day) => new Date(new Date(`${day}T00:00:00Z`).getTime() - KIGALI_OFFSET_MS);

/** "Friday 24 October" for alerts. */
const formatDay = (day) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });

const parseText = (raw, field, { min, max }) => {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length < min || value.length > max) {
    throw ApiError.badRequest(`${field} is invalid.`, { [field]: `expected ${min}-${max} characters` });
  }
  return value;
};

function serializeOffer(offer) {
  return {
    id: String(offer._id),
    title: offer.title,
    details: offer.details || '',
    offer_date: offer.offer_date,
    starts_at: offer.starts_at,
    status: offer.status,
    created_at: offer.created_at,
  };
}

class VendorOfferService {
  /** The vendor's own upcoming offer days (dashboard). */
  async listForVendor(vendor) {
    const offers = await vendorOfferRepository.listUpcomingForVendor(vendor._id, kigaliDay());
    return { offers: offers.map(serializeOffer) };
  }

  /**
   * Publishes an offer for a chosen day (tomorrow at the earliest) and alerts
   * the kitchen's clients right away.
   */
  async create(vendor, body = {}) {
    const title = parseText(body.title, 'title', { min: 2, max: offerDays.titleMax });
    const details = body.details
      ? parseText(body.details, 'details', { min: 0, max: offerDays.detailsMax })
      : '';

    const offerDate = typeof body.offer_date === 'string' ? body.offer_date.trim() : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(offerDate) || Number.isNaN(Date.parse(`${offerDate}T00:00:00Z`))) {
      throw ApiError.badRequest('offer_date is invalid.', { offer_date: 'expected a date like 2026-10-24' });
    }
    const tomorrow = kigaliDay(new Date(), 1);
    const latest = kigaliDay(new Date(), offerDays.maxDaysAhead);
    if (offerDate < tomorrow) {
      throw ApiError.badRequest('Pick a day from tomorrow onwards so clients can be alerted before it.', {
        offer_date: `expected ${tomorrow} or later`,
      });
    }
    if (offerDate > latest) {
      throw ApiError.badRequest('offer_date is too far ahead.', {
        offer_date: `expected within the next ${offerDays.maxDaysAhead} days`,
      });
    }

    const upcoming = await vendorOfferRepository.countUpcomingForVendor(vendor._id, kigaliDay());
    if (upcoming >= offerDays.maxUpcomingPerVendor) {
      throw ApiError.badRequest(
        `You can have up to ${offerDays.maxUpcomingPerVendor} upcoming offer days. Remove one to add another.`,
        { offer_date: 'too many upcoming offers' }
      );
    }

    const offer = await vendorOfferRepository.create({
      vendor_id: vendor._id,
      title,
      details,
      offer_date: offerDate,
      starts_at: kigaliMidnight(offerDate),
      // An offer for tomorrow is announced now; no separate day-before reminder.
      reminder_sent_at: offerDate === tomorrow ? new Date() : null,
    });

    this.#alertClients(vendor, offer, { reminder: false })
      .then(() => vendorOfferRepository.markAnnounced(offer._id))
      .catch((error) => console.error('[offers] announcement failed:', error.message));

    return { offer: serializeOffer(offer) };
  }

  async cancel(vendor, offerId) {
    if (!mongoose.isValidObjectId(offerId)) {
      throw ApiError.badRequest('offer_id must be a valid id.', { offer_id: 'expected a valid id' });
    }
    const offer = await vendorOfferRepository.cancel(vendor._id, offerId);
    if (!offer) throw ApiError.notFound('Offer not found.', 'OFFER_NOT_FOUND');
    return { offer: serializeOffer(offer) };
  }

  /** Public feed: every upcoming offer day from approved, active kitchens. */
  async listUpcoming(coords) {
    const offers = await vendorOfferRepository.listUpcoming(kigaliDay());
    return {
      offers: offers
        .filter((offer) => offer.vendor_id && offer.vendor_id.is_active && !offer.vendor_id.deleted_at)
        .map((offer) => {
          const vendor = offer.vendor_id;
          const distanceKm = coords ? distanceFromCoords(coords, vendor.location?.coordinates) : null;
          return {
            ...serializeOffer({ ...offer, vendor_id: vendor._id }),
            vendor: {
              ...serializeVendorCard(vendor, { distanceKm }),
              neighborhood: vendor.neighborhood || null,
            },
          };
        }),
    };
  }

  /** Sends the day-before reminders that are due (once per offer). */
  async sendDueReminders(now = new Date()) {
    const localHour = new Date(now.getTime() + KIGALI_OFFSET_MS).getUTCHours();
    if (localHour < offerDays.reminderHour) return 0;
    const tomorrow = kigaliDay(now, 1);
    let sent = 0;
    // Claim one offer at a time so each reminder goes out exactly once.
    for (
      let offer = await vendorOfferRepository.claimReminder(tomorrow);
      offer;
      offer = await vendorOfferRepository.claimReminder(tomorrow)
    ) {
      const vendor = await vendorRepository.findById(offer.vendor_id);
      if (!vendor?.is_active) continue; // suspended/hidden kitchens don't alert
      await this.#alertClients(vendor, offer, { reminder: true });
      sent += 1;
    }
    return sent;
  }

  async #alertClients(vendor, offer, { reminder }) {
    const clientIds = await vendorOfferRepository.clientIds(vendor._id);
    const day = formatDay(offer.offer_date);
    return notificationService.notifyCustomers(clientIds, {
      type: 'vendor_offer',
      title: reminder ? `Tomorrow: offer at ${vendor.name}` : `${vendor.name} has an offer on ${day}`,
      body: reminder
        ? `Don't miss it tomorrow (${day}): ${offer.title}`
        : `${offer.title}${offer.details ? ` — ${offer.details}` : ''}`,
      link: `/vendor/${vendor._id}`,
      data: { vendor_id: String(vendor._id), offer_id: String(offer._id), offer_date: offer.offer_date },
    });
  }

  /** Checks for due day-before reminders every 15 minutes while the server runs. */
  start(intervalMs = 15 * 60 * 1000) {
    const tick = () =>
      this.sendDueReminders()
        .then((sent) => sent > 0 && console.log(`[offers] sent ${sent} day-before offer reminder(s)`))
        .catch((error) => console.error('[offers] reminder check failed:', error.message));
    tick();
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    return timer;
  }
}

module.exports = new VendorOfferService();
module.exports.kigaliDay = kigaliDay;
