const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;

/** A planned shift: who works when (and in which department). */
const staffShiftSchema = new mongoose.Schema(
  {
    vendor_id: { type: ObjectId, ref: 'Vendor', required: true },
    staff_id: { type: ObjectId, ref: 'KitchenStaff', required: true },
    department_id: { type: ObjectId, ref: 'Department', default: null },
    starts_at: { type: Date, required: true },
    ends_at: { type: Date, required: true },
    note: { type: String, default: '', trim: true },
    created_by: { type: String, default: '' },
  },
  { timestamps }
);

staffShiftSchema.index({ vendor_id: 1, starts_at: 1 });
staffShiftSchema.index({ staff_id: 1, starts_at: 1 });

module.exports = mongoose.model('StaffShift', staffShiftSchema);
