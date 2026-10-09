const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    icon_url: { type: String, default: '' },
    sort_order: { type: Number, default: 0 },
  },
  { timestamps }
);

categorySchema.index({ sort_order: 1, name: 1 });
categorySchema.index({ name: 'text' });

module.exports = mongoose.model('Category', categorySchema);
