const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;

/** One clock-in / clock-out of an employee (late if after their shift started). */
const staffAttendanceSchema = new mongoose.Schema(
  {
    vendor_id: { type: ObjectId, ref: 'Vendor', required: true },
    staff_id: { type: ObjectId, ref: 'KitchenStaff', required: true },
    staff_name: { type: String, default: '' },
    shift_id: { type: ObjectId, ref: 'StaffShift', default: null },
    clock_in_at: { type: Date, required: true },
    clock_out_at: { type: Date, default: null },
    late_minutes: { type: Number, default: 0 },
    note: { type: String, default: '', trim: true },
    edited_by: { type: String, default: '' },
  },
  { timestamps }
);

staffAttendanceSchema.index({ vendor_id: 1, clock_in_at: -1 });
// At most one open clock-in per employee.
staffAttendanceSchema.index({ staff_id: 1 }, { unique: true, partialFilterExpression: { clock_out_at: null } });

module.exports = mongoose.model('StaffAttendance', staffAttendanceSchema);
