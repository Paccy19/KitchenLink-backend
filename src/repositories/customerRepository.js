const { Customer } = require('../models');

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
}

module.exports = new CustomerRepository();
