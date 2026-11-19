const { Customer } = require('../models');
const { phoneVariants } = require('../utils/identifier');

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class CustomerRepository {
  /**
   * The customer whose (verified) phone this is. Also finds numbers older
   * code stored as 07… or 2507… (migrateCustomerIdentity normalizes them).
   */
  async findByPhone(phoneNumber) {
    if (!phoneNumber) return null;
    const variants = /^\+2507\d{8}$/.test(phoneNumber) ? phoneVariants(phoneNumber) : [phoneNumber];
    return Customer.findOne({ phone_number: { $in: variants } }).lean();
  }

  /** Another customer (not `exceptId`) whose phone this is. */
  async findOtherByPhone(phoneNumber, exceptId) {
    const owner = await this.findByPhone(phoneNumber);
    return owner && String(owner._id) !== String(exceptId) ? owner : null;
  }

  async findByEmail(email) {
    return Customer.findOne({ email }).lean();
  }

  async findById(customerId) {
    return Customer.findById(customerId).lean();
  }

  async findByIds(customerIds = []) {
    if (!customerIds || customerIds.length === 0) return [];
    return Customer.find({ _id: { $in: customerIds } }).lean();
  }

  /**
   * phoneNumber: a verified phone (phone sign-up). email: a verified email
   * (email sign-up), with an optional unverified pendingPhone.
   */
  async create({ name, phoneNumber, email, pendingPhone }) {
    const customer = await Customer.create({
      name,
      ...(phoneNumber ? { phone_number: phoneNumber } : {}),
      ...(email ? { email, email_verified_at: new Date() } : {}),
      ...(pendingPhone ? { pending_phone_number: pendingPhone } : {}),
      is_verified: true,
      last_login_at: new Date(),
    });
    return customer.toObject();
  }

  async touchLogin(customerId) {
    await Customer.updateOne(
      { _id: customerId },
      { $set: { last_login_at: new Date() } }
    );
  }

  async updateLocation(customerId, { latitude, longitude, accuracyM }) {
    return Customer.findOneAndUpdate(
      { _id: customerId },
      {
        $set: {
          last_location: { type: 'Point', coordinates: [longitude, latitude] },
          last_location_accuracy_m: accuracyM,
          last_location_at: new Date(),
        },
      },
      { returnDocument: 'after' }
    ).lean();
  }

  /** `unset` lists fields to remove (e.g. clearing the optional email). */
  async update(customerId, update, { unset = [] } = {}) {
    const ops = {};
    if (Object.keys(update).length) ops.$set = update;
    if (unset.length) ops.$unset = Object.fromEntries(unset.map((field) => [field, '']));
    return Customer.findOneAndUpdate({ _id: customerId }, ops, { returnDocument: 'after' }).lean();
  }

  /* ------------------------------- admin ------------------------------- */

  async adminList({ search, isActive, limit, offset }) {
    const filter = {};
    if (isActive !== undefined) filter.is_active = isActive;
    if (search) {
      const regex = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ name: regex }, { phone_number: regex }];
    }

    const [customers, total] = await Promise.all([
      Customer.find(filter).sort({ created_at: -1 }).skip(offset).limit(limit).lean(),
      Customer.countDocuments(filter),
    ]);
    return { customers, total };
  }

  async countAll() {
    return Customer.countDocuments();
  }

  async countActive() {
    return Customer.countDocuments({ is_active: { $ne: false } });
  }

  async countSince(date) {
    return Customer.countDocuments({ created_at: { $gte: date } });
  }

  async findByIdsWithOrders(customerIds = []) {
    if (!customerIds || customerIds.length === 0) return [];
    return Customer.find({ _id: { $in: customerIds } }).lean();
  }
}

module.exports = new CustomerRepository();
