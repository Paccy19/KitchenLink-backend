const config = require('../config');
const ApiError = require('../utils/ApiError');
const { signToken } = require('../utils/jwt');
const { normalizePhone, parseName } = require('../utils/validators');
const { parseEmail } = require('../utils/vendorValidators');
const { identifierFrom, nameKey, sameName, maskEmail } = require('../utils/identifier');
const { resolveImageUrl } = require('../utils/uploads');
const { Customer } = require('../models');
const customerRepository = require('../repositories/customerRepository');
const vendorRepository = require('../repositories/vendorRepository');
const driverRepository = require('../repositories/driverRepository');
const adminRepository = require('../repositories/adminRepository');
const loginOtpService = require('./loginOtpService');

const serializeCustomer = (customer) => ({
  id: String(customer._id),
  name: customer.name,
  // Always a verified phone (or null for an email sign-up without one yet).
  phone_number: customer.phone_number || null,
  phone_verified: Boolean(customer.phone_number),
  pending_phone_number: customer.pending_phone_number || null,
  email: customer.email || null,
  email_verified: Boolean(customer.email && customer.email_verified_at),
  pending_email: customer.pending_email || null,
  profile_image_url: customer.profile_image_url || null,
});

const PHONE_TAKEN_MESSAGE =
  'This phone number is already associated with another customer account. Please use your own phone number or sign in to your existing account.';
/** Never says whose account it is: no name, email or anything else about them. */
const phoneTaken = () => new ApiError(409, 'PHONE_BELONGS_TO_ANOTHER_CUSTOMER', PHONE_TAKEN_MESSAGE);
const emailTaken = () =>
  new ApiError(
    409,
    'EMAIL_BELONGS_TO_ANOTHER_CUSTOMER',
    'This email address is already associated with another customer account. Please use your own email address or sign in to your existing account.'
  );
const emailNotVerified = () =>
  new ApiError(
    409,
    'EMAIL_NOT_VERIFIED',
    "This email isn't verified on a KitchenLink account yet. Sign in with your phone number, then verify your email in your profile."
  );
const isDuplicateKey = (error) => error?.code === 11000;

/**
 * The kitchen owner and delivery worker registered with this phone, with the
 * name each registered under (the owner's own name for a kitchen).
 */
async function linkedAccounts(phone) {
  const [vendor, driver] = await Promise.all([
    vendorRepository.findByPhone(phone),
    driverRepository.findByPhone(phone),
  ]);
  return [
    vendor && { role: 'kitchen', name: vendor.owner_name || vendor.name },
    driver && { role: 'delivery worker', name: driver.name },
  ].filter((account) => account && account.name);
}

/**
 * A kitchen owner or delivery worker signing in as a customer must give the
 * same name they registered with, so the customer account is known to be
 * theirs. Returns the registered name to use (null for an ordinary phone).
 * The error never reveals the registered name.
 */
async function assertLinkedName(phone, name) {
  const accounts = await linkedAccounts(phone);
  if (!accounts.length) return null;
  const roles = accounts.map((account) => account.role).join(' and ');
  if (!nameKey(name)) {
    throw new ApiError(
      400,
      'NAME_REQUIRED',
      `This phone number is registered as a ${roles} on KitchenLink. Enter the full name you registered with.`,
      { name: 'required for this phone number' }
    );
  }
  if (accounts.some((account) => !sameName(account.name, name))) {
    throw new ApiError(
      400,
      'NAME_DOES_NOT_MATCH',
      `This phone number is registered as a ${roles} on KitchenLink. Enter the same full name you used when you registered as a ${roles}.`,
      { name: 'does not match the registered name' }
    );
  }
  return accounts[0].name;
}

/**
 * The phone belongs to a customer account: a different name means a
 * different person trying to use it, so it is refused. No name given is an
 * ordinary sign-in (the code to that phone is the proof).
 */
function assertSameCustomer(existing, name) {
  if (existing && nameKey(name) && !sameName(name, existing.name)) throw phoneTaken();
}

/**
 * Customer sign-in, and sign-up, with one field: a phone number or an email
 * address (the server tells which). A code goes to that phone or inbox; the
 * verified code signs the customer in, or creates their account when the
 * phone/email has none yet (the customer form is also the sign-up form).
 *
 * Phone ownership: a customer's `phone_number` is always a phone proven with a
 * code. A phone given at email sign-up is kept as `pending_phone_number` until
 * the customer verifies it, and is refused if it is already another customer's
 * (different name) or already has an account (same name: sign in instead).
 */
class AuthService {
  async sendOtp(body = {}) {
    const identifier = identifierFrom(body, 'phone_number', 'email');
    return identifier.type === 'phone' ? this.#sendPhoneCode(identifier, body.name) : this.#sendEmailCode(identifier, body);
  }

  async #sendPhoneCode(identifier, name) {
    const phone = identifier.value;
    if (await adminRepository.findByPhone(phone)) {
      throw new ApiError(
        400,
        'PASSWORD_REQUIRED',
        'Administrator accounts sign in with their password on the unified sign-in page.'
      );
    }
    // Checked before any code is sent: a wrong name gets no SMS.
    const registeredName = await assertLinkedName(phone, name);
    const existing = await customerRepository.findByPhone(phone);
    assertSameCustomer(existing, name);
    const pendingName = existing ? null : registeredName || parseName(name);

    const sent = await loginOtpService.send({ identifier, purpose: 'customer', name: pendingName || undefined });
    return { phone_number: phone, identifier: phone, requires_name: !existing, ...sent };
  }

  async #sendEmailCode(identifier, body) {
    const email = identifier.value;
    if (await adminRepository.findByEmail(email)) {
      throw new ApiError(
        400,
        'PASSWORD_REQUIRED',
        'Administrator accounts sign in with their password on the unified sign-in page.'
      );
    }
    const existing = await customerRepository.findByEmail(email);
    if (existing) {
      if (!existing.email_verified_at) throw emailNotVerified();
      if (nameKey(body.name) && !sameName(body.name, existing.name)) throw emailTaken();
      const sent = await loginOtpService.send({ identifier, purpose: 'customer' });
      return { identifier: email, email, requires_name: false, ...sent };
    }

    // Sign-up with an email: a name, and optionally a phone (checked now and
    // again when the account is created; saved unverified).
    const name = parseName(body.name);
    const registrationPhone = await this.#checkRegistrationPhone(this.#registrationPhoneFrom(body), name);
    const sent = await loginOtpService.send({ identifier, purpose: 'customer', name, registrationPhone: registrationPhone || undefined });
    return { identifier: email, email, requires_name: true, ...sent };
  }

  /** With `identifier`, `phone_number` is the optional phone of an email sign-up. */
  #registrationPhoneFrom(body) {
    if (body.registration_phone !== undefined) return body.registration_phone;
    return body.identifier !== undefined ? body.phone_number : undefined;
  }

  /**
   * The phone given at email sign-up must not be another customer's, nor
   * already have its own account (that person signs in with it instead).
   */
  async #checkRegistrationPhone(raw, name) {
    if (raw === undefined || raw === null || String(raw).trim() === '') return null;
    const phone = normalizePhone(raw);
    await assertLinkedName(phone, name);
    const owner = await customerRepository.findByPhone(phone);
    if (owner) {
      if (!sameName(name, owner.name)) throw phoneTaken();
      throw new ApiError(
        409,
        'PHONE_HAS_ACCOUNT',
        'This phone number already has a KitchenLink customer account. Sign in with your phone number, then add this email in your profile.'
      );
    }
    return phone;
  }

  async verifyOtp(body = {}) {
    const identifier = identifierFrom(body, 'phone_number', 'email');
    const admin = identifier.type === 'phone'
      ? await adminRepository.findByPhone(identifier.value)
      : await adminRepository.findByEmail(identifier.value);
    if (admin) {
      throw new ApiError(
        400,
        'PASSWORD_REQUIRED',
        'Administrator accounts sign in with their password on the unified sign-in page.'
      );
    }
    if (identifier.type === 'email') {
      const otp = await loginOtpService.verify({ identifier, purpose: 'customer', code: body.code });
      return this.#emailSession(identifier.value, otp, body.name);
    }

    const phone = identifier.value;
    // Before the code is used up: a different person's name is refused.
    assertSameCustomer(await customerRepository.findByPhone(phone), body.name);
    const otp = await loginOtpService.verify({ identifier, purpose: 'customer', code: body.code });

    return this.customerSession(phone, { name: body.name, otpName: otp.name });
  }

  /**
   * The customer session for a verified phone: signs in the customer with
   * this phone, or creates their account (with the name given). Used by
   * verifyOtp and by an admin who chose to continue as a customer.
   */
  async customerSession(phone, { name, otpName = null } = {}) {
    // Same rule as when the code was sent (the name may be resent here).
    const registeredName = await assertLinkedName(phone, name ?? otpName);

    let customer = await customerRepository.findByPhone(phone);
    assertSameCustomer(customer, name ?? otpName);
    if (!customer) {
      // A kitchen owner or delivery worker gets their registered name.
      const customerName = registeredName || (name ? parseName(name) : null) || (otpName ? parseName(otpName) : null);
      if (!customerName) {
        throw ApiError.badRequest(
          'name is required to complete registration.',
          { name: 'expected a non-empty string' }
        );
      }
      try {
        customer = await customerRepository.create({ name: customerName, phoneNumber: phone });
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        // Someone else's sign-up claimed this phone a moment ago (the unique
        // index decides): only the same person may continue, into that account.
        customer = await customerRepository.findByPhone(phone);
        if (!customer || !sameName(customerName, customer.name)) throw phoneTaken();
      }
    } else {
      await customerRepository.touchLogin(customer._id);
      customer = { ...customer, last_login_at: new Date() };
    }
    return this.#session(customer);
  }

  /** A verified email code: the customer with that (verified) email, or a new account. */
  async #emailSession(email, otp, name) {
    let customer = await customerRepository.findByEmail(email);
    if (customer) {
      if (!customer.email_verified_at) throw emailNotVerified();
      if (nameKey(name) && !sameName(name, customer.name)) throw emailTaken();
      await customerRepository.touchLogin(customer._id);
      return this.#session({ ...customer, last_login_at: new Date() });
    }

    const customerName = parseName(otp.name || name);
    // Checked again: the phone may have been claimed since the code was sent.
    const pendingPhone = otp.registration_phone ? await this.#checkRegistrationPhone(otp.registration_phone, customerName) : null;
    try {
      customer = await customerRepository.create({ name: customerName, email, pendingPhone });
    } catch (error) {
      if (isDuplicateKey(error)) throw ApiError.conflict('An account with this email was just created. Sign in again.', 'EMAIL_ALREADY_REGISTERED');
      throw error;
    }
    return this.#session(customer);
  }

  #session(customer) {
    const token = signToken({ sub: String(customer._id), ...(customer.phone_number ? { phone: customer.phone_number } : {}) });
    return {
      token,
      token_type: 'Bearer',
      expires_in: config.auth.jwtExpiresIn,
      customer: serializeCustomer(customer),
    };
  }

  async me(customer) {
    return { customer: serializeCustomer(customer) };
  }

  async updateProfile(customer, body = {}, file) {
    const payload = {};

    if (body.name !== undefined) {
      payload.name = parseName(body.name);
      // A phone that is also a kitchen's or delivery worker's keeps that
      // person's registered name, so a rename can't hand it to someone else.
      if (customer.phone_number && !sameName(payload.name, customer.name)) {
        await assertLinkedName(customer.phone_number, payload.name);
      }
    }

    // Phone and email change only through their code (see start/confirm
    // below); the current values may be sent back unchanged.
    if (body.phone_number !== undefined && body.phone_number !== null && String(body.phone_number).trim() !== '') {
      const phone = normalizePhone(body.phone_number);
      if (phone !== customer.phone_number) {
        throw new ApiError(409, 'PHONE_VERIFICATION_REQUIRED', 'Verify your new phone number with the code we send to it first.');
      }
    }

    const unset = [];
    if (body.email !== undefined) {
      if (body.email === null || String(body.email).trim() === '') {
        unset.push('email', 'pending_email');
        payload.email_verified_at = null;
      } else if (parseEmail(body.email) !== customer.email) {
        throw new ApiError(409, 'EMAIL_VERIFICATION_REQUIRED', 'Verify your new email address with the code we send to it first.');
      }
    }

    const profileImageUrl = await resolveImageUrl({
      file,
      image_url: body.profile_image_url,
      image_base64: body.profile_image_base64,
    });
    if (profileImageUrl !== undefined) payload.profile_image_url = profileImageUrl;

    if (Object.keys(payload).length === 0 && unset.length === 0) {
      if (body.phone_number !== undefined || body.email !== undefined) return { customer: serializeCustomer(customer) };
      throw ApiError.badRequest('No supported profile fields were provided.', {
        body: 'expected name, phone_number, email or profile_image',
      });
    }

    const updated = await customerRepository.update(customer._id, payload, { unset });
    return { customer: serializeCustomer(updated) };
  }

  /* ------------------------ changing phone / email ----------------------- */

  /**
   * Step 1 of a new phone: refused if it is another customer's; otherwise a
   * code goes to it. The current phone stays the account's until step 2.
   */
  async startPhoneChange(customer, body = {}) {
    const phone = normalizePhone(body.phone_number ?? body.phone);
    if (phone === customer.phone_number) throw ApiError.badRequest('This is already your phone number.', { phone_number: 'unchanged' });
    if (await customerRepository.findOtherByPhone(phone, customer._id)) throw phoneTaken();
    await assertLinkedName(phone, customer.name);
    await customerRepository.update(customer._id, { pending_phone_number: phone });
    const sent = await loginOtpService.send({
      identifier: { type: 'phone', value: phone },
      purpose: 'customer',
      context: 'change_phone',
      message: (code) => `KitchenLink: your code to verify this phone number is ${code}. It expires in ${config.auth.otpTtlMinutes} minutes. Never share it.`,
    });
    return { pending_phone_number: phone, ...sent };
  }

  /** Step 2: the code proves the new phone; only then does it replace the old one. */
  async confirmPhoneChange(customer, body = {}) {
    const phone = customer.pending_phone_number;
    if (!phone) throw new ApiError(400, 'PHONE_CODE_NOT_SENT', 'Enter your new phone number and request a code first.');
    await loginOtpService.verify({ identifier: { type: 'phone', value: phone }, purpose: 'customer', context: 'change_phone', code: body.code });
    if (await customerRepository.findOtherByPhone(phone, customer._id)) throw phoneTaken();
    let updated;
    try {
      updated = await Customer.findOneAndUpdate(
        { _id: customer._id, pending_phone_number: phone },
        { $set: { phone_number: phone }, $unset: { pending_phone_number: 1 } },
        { returnDocument: 'after' }
      ).lean();
    } catch (error) {
      if (isDuplicateKey(error)) throw phoneTaken();
      throw error;
    }
    if (!updated) throw ApiError.conflict('Your new phone number was changed meanwhile. Request a new code.', 'PHONE_CHANGED');
    return { customer: serializeCustomer(updated) };
  }

  /** Step 1 of an email (new, or the current one not verified yet): a code goes to it. */
  async startEmailVerification(customer, body = {}) {
    const email = parseEmail(body.email ?? customer.email);
    if (email === customer.email && customer.email_verified_at) {
      throw ApiError.badRequest('This email address is already verified.', { email: 'already verified' });
    }
    const other = await customerRepository.findByEmail(email);
    if (other && String(other._id) !== String(customer._id)) throw emailTaken();
    await customerRepository.update(customer._id, { pending_email: email });
    const sent = await loginOtpService.send({
      identifier: { type: 'email', value: email },
      purpose: 'customer',
      context: 'verify_email',
      label: 'email verification',
    });
    return { pending_email: email, ...sent };
  }

  /** Step 2: the code proves the email; it becomes the account's verified email. */
  async confirmEmailVerification(customer, body = {}) {
    const email = customer.pending_email;
    if (!email) throw new ApiError(400, 'EMAIL_CODE_NOT_SENT', 'Enter your email address and request a code first.');
    await loginOtpService.verify({ identifier: { type: 'email', value: email }, purpose: 'customer', context: 'verify_email', code: body.code });
    const other = await customerRepository.findByEmail(email);
    if (other && String(other._id) !== String(customer._id)) throw emailTaken();
    let updated;
    try {
      updated = await Customer.findOneAndUpdate(
        { _id: customer._id, pending_email: email },
        { $set: { email, email_verified_at: new Date() }, $unset: { pending_email: 1 } },
        { returnDocument: 'after' }
      ).lean();
    } catch (error) {
      if (isDuplicateKey(error)) throw emailTaken();
      throw error;
    }
    if (!updated) throw ApiError.conflict('Your email address was changed meanwhile. Request a new code.', 'EMAIL_CHANGED');
    return { customer: serializeCustomer(updated), verified_email: maskEmail(email) };
  }

  /** Records the customer's current GPS position (sent while location tracking is on). */
  async updateLocation(customer, body = {}) {
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);
    if (
      !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180
    ) {
      throw ApiError.badRequest('latitude and longitude must be valid coordinates.', {
        latitude: 'expected a number between -90 and 90',
        longitude: 'expected a number between -180 and 180',
      });
    }
    const accuracy = Number(body.accuracy_m);
    const accuracyM = Number.isFinite(accuracy) && accuracy >= 0 ? Math.round(accuracy) : null;

    const updated = await customerRepository.updateLocation(customer._id, {
      latitude,
      longitude,
      accuracyM,
    });
    return {
      recorded: true,
      recorded_at: updated?.last_location_at ?? new Date(),
    };
  }
}

module.exports = new AuthService();
module.exports.PHONE_TAKEN_MESSAGE = PHONE_TAKEN_MESSAGE;
