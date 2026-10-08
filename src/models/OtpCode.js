const mongoose = require('mongoose');

const otpCodeSchema = new mongoose.Schema(
  {
    phone_number: { type: String, required: true, index: true },
    code: { type: String, required: true },
    name: { type: String, trim: true },
    attempts: { type: Number, default: 0 },
    expires_at: { type: Date, required: true },
    consumed_at: { type: Date },
  },
  { timestamps: true }
);

otpCodeSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });
otpCodeSchema.index({ phone_number: 1, created_at: -1 });

module.exports = mongoose.model('OtpCode', otpCodeSchema);
