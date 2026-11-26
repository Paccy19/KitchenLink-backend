const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;

/**
 * A service or department inside one kitchen (Food, Coffee, Bakery, Bar …).
 * Optional: a kitchen with no departments works as one kitchen. Menu items
 * point at the department that prepares them, and each order is split into
 * one preparation ticket per department (Order.tickets).
 */
const departmentSchema = new mongoose.Schema(
  {
    vendor_id: { type: ObjectId, ref: 'Vendor', required: true },
    name: { type: String, required: true, trim: true },
    // One of kitchenAccess.DEPARTMENT_CATEGORIES ids, or 'custom'.
    category: { type: String, default: 'custom', trim: true },
    // Shown when category is 'custom' (e.g. "Ice cream bar").
    custom_category: { type: String, default: '', trim: true },
    description: { type: String, default: '', trim: true },
    image_url: { type: String, default: '' },
    // Ticket prefix (F1024, C1024 …).
    code_prefix: { type: String, default: 'X', trim: true, uppercase: true },
    is_active: { type: Boolean, default: true },
    sort_order: { type: Number, default: 0 },
    manager_staff_ids: [{ type: ObjectId, ref: 'KitchenStaff' }],
    // Preparation stations inside the department (Grill, Fryer, Espresso bar …).
    stations: [{ _id: false, id: { type: String, required: true }, name: { type: String, required: true, trim: true } }],
    // Which stages this department uses and what it calls them.
    workflow: {
      use_accept: { type: Boolean, default: true },
      use_preparing: { type: Boolean, default: true },
      labels: {
        pending: { type: String, default: 'Pending', trim: true },
        accepted: { type: String, default: 'Accepted', trim: true },
        preparing: { type: String, default: 'Preparing', trim: true },
        ready: { type: String, default: 'Ready', trim: true },
      },
    },
    // Empty = follows the kitchen's hours. Same shape as Vendor.operating_hours.
    operating_hours: { type: [mongoose.Schema.Types.Mixed], default: [] },
    deleted_at: { type: Date, default: null },
  },
  { timestamps }
);

departmentSchema.index({ vendor_id: 1, deleted_at: 1, sort_order: 1 });

module.exports = mongoose.model('Department', departmentSchema);
