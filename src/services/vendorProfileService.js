const ApiError = require('../utils/ApiError');
const { normalizePhone } = require('../utils/validators');
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

class VendorProfileService {
  async update(vendor, body = {}, file) {
    const payload = {};

    if (body.name !== undefined) {
      payload.name = parseRequiredText(body.name, {
        field: 'name',
        min: 2,
        max: 120,
      });
    }
    if (body.owner_name !== undefined) {
      payload.owner_name = parseOptionalText(body.owner_name, {
        field: 'owner_name',
        max: 120,
      });
    }
    if (body.description !== undefined) {
      payload.description =
        parseOptionalText(body.description, { field: 'description', max: 1000 }) ||
        '';
    }
    if (body.is_open !== undefined) {
      payload.is_open = parseBooleanValue(body.is_open, { field: 'is_open' });
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

    const bannerImageUrl = resolveImageUrl({
      file,
      image_url: body.banner_image_url,
      image_base64: body.banner_image_base64,
    });
    if (bannerImageUrl !== undefined) payload.banner_image_url = bannerImageUrl;

    if (Object.keys(payload).length === 0) {
      throw ApiError.badRequest('No supported profile fields were provided.', {
        body: 'expected name, owner_name, description, phone, is_open, operating_hours, payment_information or banner_image',
      });
    }

    const updated = await vendorRepository.update(vendor._id, payload);
    return { vendor: serializeVendorAccount(updated) };
  }
}

module.exports = new VendorProfileService();
