const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const otpCodeSchema = new mongoose.Schema(
  {
    phone_number: { type: String, required: true, index: true },
    purpose: {
      type: String,
      enum: ['customer', 'vendor', 'driver'],
      default: 'customer',
    },
    code: { type: String, required: true },
    name: { type: String, trim: true },
    attempts: { type: Number, default: 0 },
    expires_at: { type: Date, required: true },
    consumed_at: { type: Date },
  },
  { timestamps }
);

otpCodeSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });
otpCodeSchema.index({ phone_number: 1, created_at: -1 });
otpCodeSchema.index({ phone_number: 1, purpose: 1, created_at: -1 });

module.exports = mongoose.model('OtpCode', otpCodeSchema);
