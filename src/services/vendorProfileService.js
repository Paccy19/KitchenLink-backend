const ApiError = require('../utils/ApiError');
const { NAME_MAX_LENGTH, capitalizeName, normalizePhone } = require('../utils/validators');
const {
  parseRequiredText,
  parseOptionalText,
  parseBooleanValue,
  parseOperatingHours,
  parsePaymentInformation,
} = require('../utils/vendorValidators');
const { serializeVendorAccount } = require('../utils/serializers');
const { resolveImageUrl } = require('../utils/uploads');
const vendorRepository = require('../repositories/vendorRepository');
const notificationService = require('./notificationService');
const { parseVendorType, vendorTypeLabel } = require('../config/vendorTypes');

class VendorProfileService {
  async update(vendor, body = {}, files = {}) {
    const payload = {};

    if (body.name !== undefined) {
      payload.name = parseRequiredText(body.name, {
        field: 'name',
        min: 2,
        max: NAME_MAX_LENGTH,
      });
    }
    if (body.owner_name !== undefined) {
      const ownerName = parseOptionalText(body.owner_name, {
        field: 'owner_name',
        max: NAME_MAX_LENGTH,
      });
      payload.owner_name = ownerName ? capitalizeName(ownerName) : ownerName;
    }
    if (body.description !== undefined) {
      payload.description =
        parseOptionalText(body.description, { field: 'description', max: 1000 }) ||
        '';
    }
    if (body.phone !== undefined) {
      const phone = normalizePhone(body.phone);
      const existing = await vendorRepository.findByPhone(phone);
      if (existing && String(existing._id) !== String(vendor._id)) {
        throw ApiError.conflict(
          'A vendor with this phone number is already registered.',
          'PHONE_ALREADY_REGISTERED'
        );
      }
      payload.phone = phone;
    }
    if (body.operating_hours !== undefined) {
      payload.operating_hours = parseOperatingHours(body.operating_hours);
    }
    if (body.payment_information !== undefined) {
      payload.payment_information = parsePaymentInformation(
        body.payment_information
      );
    }

    // Kitchen location (profile settings): the registered coordinates of the
    // kitchen and the written address and neighbourhood customers see.
    if (body.location !== undefined) {
      const location = body.location && typeof body.location === 'object' ? body.location : null;
      if (!location) {
        throw ApiError.badRequest('location must be an object.', {
          location: 'expected { latitude, longitude, address, neighborhood }',
        });
      }
      if (location.latitude !== undefined || location.longitude !== undefined) {
        const { lat, lng } = parseKitchenCoords(location.latitude, location.longitude);
        payload.location = { type: 'Point', coordinates: [lng, lat] };
        // When the coordinates were last edited; they are entered, not measured.
        payload.location_updated_at = new Date();
        payload.location_accuracy_m = null;
      }
      if (location.address !== undefined) {
        payload.address = parseRequiredText(location.address, { field: 'address', min: 3, max: 200 });
      }
      if (location.neighborhood !== undefined) {
        payload.neighborhood =
          parseOptionalText(location.neighborhood, { field: 'neighborhood', max: 120 }) || '';
      }
    }

    const bannerImageUrl = resolveImageUrl({
      file: files?.banner_image?.[0],
      image_url: body.banner_image_url,
      image_base64: body.banner_image_base64,
    });
    if (bannerImageUrl !== undefined) payload.banner_image_url = bannerImageUrl;

    const profileImageUrl = resolveImageUrl({
      file: files?.profile_image?.[0],
      image_url: body.profile_image_url,
      image_base64: body.profile_image_base64,
    });
    if (profileImageUrl !== undefined) payload.profile_image_url = profileImageUrl;

    if (Object.keys(payload).length === 0) {
      throw ApiError.badRequest('No supported profile fields were provided.', {
        body: 'expected name, owner_name, description, phone, location, operating_hours, payment_information, banner_image or profile_image',
      });
    }

    const updated = await vendorRepository.update(vendor._id, payload);
    return { vendor: serializeVendorAccount(updated) };
  }

  /**
   * The vendor asks an admin to change their vendor type (e.g. Home Cook →
   * Caterer). The type only changes when an admin approves it.
   */
  async requestTypeChange(vendor, body = {}) {
    const requested = parseVendorType(body.vendor_type);
    if (requested === vendor.vendor_type) {
      throw ApiError.badRequest('That is already your vendor type.', { vendor_type: 'choose a different type' });
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 300) : '';
    const updated = await vendorRepository.update(vendor._id, {
      vendor_type_request: { vendor_type: requested, reason, requested_at: new Date() },
    });
    const because = reason ? `: "${reason}"` : '.';
    notificationService
      .notifyAdmin({
        type: 'vendor_type_request',
        title: 'Vendor type change requested',
        body: `${vendor.name} asked to change from ${vendorTypeLabel(vendor.vendor_type)} to ${vendorTypeLabel(requested)}${because}`,
        link: `/admin-dashboard/vendors?vendor=${vendor._id}`,
        data: { vendor_id: String(vendor._id), vendor_type: requested },
      })
      .catch(() => null);
    return { vendor: serializeVendorAccount(updated) };
  }

  /** Withdraws a pending type change request. */
  async cancelTypeChange(vendor) {
    const updated = await vendorRepository.update(vendor._id, {
      vendor_type_request: { vendor_type: null, reason: '', requested_at: null },
    });
    return { vendor: serializeVendorAccount(updated) };
  }

  /**
   * Opens or closes the store. An open store shows on the map and to nearby
   * customers at its registered kitchen coordinates; the vendor's own position
   * is never read, so they can run the business from anywhere.
   */
  async setAvailability(vendor, body = {}) {
    const isOpen = parseBooleanValue(body.is_open, { field: 'is_open' });
    if (isOpen === undefined) {
      throw ApiError.badRequest('is_open is required.', { is_open: 'expected true or false' });
    }

    if (isOpen) {
      const [lng, lat] = vendor.location?.coordinates ?? [];
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new ApiError(
          400,
          'LOCATION_REQUIRED',
          "Add your kitchen's coordinates in Profile settings before opening your store.",
          { location: 'required' }
        );
      }
    }

    const updated = await vendorRepository.update(vendor._id, { is_open: isOpen });
    return { vendor: serializeVendorAccount(updated) };
  }
}

/** Kitchen latitude/longitude as entered by the vendor, validated together. */
function parseKitchenCoords(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  const blank = (value) => value === undefined || value === null || value === '';
  if (blank(latitude) || blank(longitude) || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw ApiError.badRequest('Enter both the latitude and longitude of your kitchen.', {
      latitude: 'expected a number between -90 and 90',
      longitude: 'expected a number between -180 and 180',
    });
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw ApiError.badRequest('Kitchen coordinates are out of range.', {
      latitude: 'expected a number between -90 and 90',
      longitude: 'expected a number between -180 and 180',
    });
  }
  return { lat, lng };
}

module.exports = new VendorProfileService();
