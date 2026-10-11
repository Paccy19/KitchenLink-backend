const { Customer } = require('../models');

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class CustomerRepository {
  async findByPhone(phoneNumber) {
    return Customer.findOne({ phone_number: phoneNumber }).lean();
  }

  async findById(customerId) {
    return Customer.findById(customerId).lean();
  }

  async findByIds(customerIds = []) {
    if (!customerIds || customerIds.length === 0) return [];
    return Customer.find({ _id: { $in: customerIds } }).lean();
  }

  async create({ name, phoneNumber }) {
    const customer = await Customer.create({
      name,
      phone_number: phoneNumber,
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

  async update(customerId, update) {
    return Customer.findOneAndUpdate(
      { _id: customerId },
      { $set: update },
      { new: true }
    ).lean();
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
