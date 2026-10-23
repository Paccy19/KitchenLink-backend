const { Admin } = require('../models');

class AdminRepository {
  async findById(adminId) {
    return Admin.findOne({ _id: adminId, deleted_at: null }).lean();
  }

  /** Used only by the admin login flow; includes the password hash. */
  async findByEmailWithPassword(email) {
    return Admin.findOne({ email, deleted_at: null })
      .select('+password_hash')
      .lean();
  }

  async findByPhone(phone) {
    return Admin.findOne({ phone }).lean();
  }

  async findByEmail(email) {
    return Admin.findOne({ email, deleted_at: null }).lean();
  }

  async create(doc) {
    const admin = await Admin.create(doc);
    return admin.toObject();
  }

  async update(adminId, update) {
    return Admin.findOneAndUpdate(
      { _id: adminId, deleted_at: null },
      { $set: update },
      { new: true }
    ).lean();
  }

  async touchLogin(adminId) {
    await Admin.updateOne(
      { _id: adminId },
      { $set: { last_login_at: new Date() } }
    );
  }

  async list({ limit, offset }) {
    const [admins, total] = await Promise.all([
      Admin.find({ deleted_at: null })
        .sort({ created_at: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      Admin.countDocuments({ deleted_at: null }),
    ]);
    return { admins, total };
  }

  async count() {
    return Admin.countDocuments({ deleted_at: null });
  }

  async listSuperAdmins() {
    return Admin.find({ role: 'super_admin', is_active: { $ne: false }, deleted_at: null }).lean();
  }
}

module.exports = new AdminRepository();
