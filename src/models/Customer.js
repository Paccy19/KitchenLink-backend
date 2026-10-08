const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone_number: { type: String, required: true, unique: true },
    is_verified: { type: Boolean, default: true },
    last_login_at: { type: Date },
  },
  { timestamps: true }
);

customerSchema.index({ phone_number: 1 }, { unique: true });

module.exports = mongoose.model('Customer', customerSchema);
