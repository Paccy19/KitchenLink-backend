const ApiError = require('../utils/ApiError');
const {
  parseEmail,
  parsePassword,
  parseRequiredText,
} = require('../utils/vendorValidators');
const { parseVehicleType } = require('../utils/deliveryValidators');
const { serializeDriverAccount } = require('../utils/serializers');
const { resolveImageUrl } = require('../utils/uploads');
const { hashPassword, comparePassword } = require('../utils/password');
const driverRepository = require('../repositories/driverRepository');

class DriverProfileService {
  async update(driver, body = {}, file) {
    const payload = {};

    if (body.name !== undefined) {
      payload.name = parseRequiredText(body.name, { field: 'name', min: 2, max: 120 });
    }
    if (body.email !== undefined) {
      payload.email =
        body.email === null || String(body.email).trim() === ''
          ? undefined
          : parseEmail(body.email);
    }
    if (body.vehicle_type !== undefined) {
      payload.vehicle_type = parseVehicleType(body.vehicle_type);
    }
    if (body.plate_number !== undefined) {
      payload.plate_number =
        body.plate_number === null
          ? ''
          : String(body.plate_number).trim().slice(0, 20);
    }
    if (body.license_number !== undefined) {
      payload.license_number =
        body.license_number === null
          ? ''
          : String(body.license_number).trim().slice(0, 40);
    }
    if (body.current_password !== undefined || body.new_password !== undefined) {
      const currentPassword =
        body.current_password !== undefined
          ? parsePassword(body.current_password, { field: 'current_password' })
          : undefined;
      const newPassword = parsePassword(body.new_password, { field: 'new_password' });
      if (!currentPassword) {
        throw ApiError.badRequest('current_password is required to change it.', {
          current_password: 'expected a non-empty string',
        });
      }
      const fresh = await driverRepository.findByIdWithPassword(driver._id);
      const ok = await comparePassword(currentPassword, fresh?.password_hash || '');
      if (!ok) {
        throw ApiError.unauthorized(
          'Current password is incorrect.',
          'INVALID_CREDENTIALS'
        );
      }
      payload.password_hash = await hashPassword(newPassword);
    }

    const profileImageUrl = resolveImageUrl({
      file,
      image_url: body.profile_image_url,
      image_base64: body.profile_image_base64,
    });
    if (profileImageUrl !== undefined) payload.profile_image_url = profileImageUrl;

    if (Object.keys(payload).length === 0) {
      throw ApiError.badRequest('No supported profile fields were provided.', {
        body: 'expected name, email, vehicle_type, plate_number, license_number, current_password, new_password or profile_image',
      });
    }

    const updated = await driverRepository.update(driver._id, payload);
    return { driver: serializeDriverAccount(updated) };
  }
}

module.exports = new DriverProfileService();