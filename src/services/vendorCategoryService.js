const { Category, Vendor } = require('../models');
const {
  VENDOR_TYPES,
  DEFAULT_CATEGORY_ALIASES,
  defaultCategoryNamesFor,
  toVendorTypeCode,
} = require('../config/vendorTypes');

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactName = (name) => new RegExp(`^${escapeRegex(name)}$`, 'i');

/**
 * Automatic food categories by vendor type (config/vendorTypes.js
 * DEFAULT_FOOD_CATEGORIES). A kitchen never picks its food categories: it gets
 * its type's defaults at registration and again when its type changes.
 *
 * Each default name is looked up among the real Category records, case-
 * insensitively, then by its aliases (Beverages → Drinks). Categories an
 * admin hid are skipped. If an admin renamed or removed every default, the
 * categories tagged for the type (Category.vendor_types) are used instead.
 */
class VendorCategoryService {
  /** [{ _id, name }] for a vendor type, in the mapping's order. */
  async defaultsFor(vendorType) {
    const code = toVendorTypeCode(vendorType);
    const found = [];
    const seen = new Set();
    const add = (category) => {
      if (!category || seen.has(String(category._id))) return;
      seen.add(String(category._id));
      found.push({ _id: category._id, name: category.name });
    };
    for (const name of defaultCategoryNamesFor(code)) {
      let category = null;
      for (const candidate of [name, ...(DEFAULT_CATEGORY_ALIASES[name] || [])]) {
        category = await Category.findOne({ name: exactName(candidate), is_active: { $ne: false } }, { name: 1 }).lean();
        if (category) break;
      }
      add(category);
    }
    if (!found.length && code) {
      const tagged = await Category.find({ vendor_types: code, is_active: { $ne: false } }, { name: 1 }).sort({ sort_order: 1 }).lean();
      tagged.forEach(add);
    }
    return found;
  }

  /** What the Vendor document stores (`food_category_ids` + `food_categories`). */
  async fieldsFor(vendorType) {
    const categories = await this.defaultsFor(vendorType);
    return {
      food_category_ids: categories.map((category) => category._id),
      food_categories: categories.map((category) => category.name),
    };
  }

  /** Every vendor type with the categories it gets (registration preview). */
  async typesWithDefaults() {
    return Promise.all(
      VENDOR_TYPES.map(async (type) => ({
        ...type,
        default_categories: (await this.defaultsFor(type.code)).map((category) => ({ id: String(category._id), name: category.name })),
      }))
    );
  }

  /** The kitchen's type changed: its food categories become the new type's defaults. */
  async reassign(vendorId, vendorType) {
    const fields = await this.fieldsFor(vendorType);
    await Vendor.updateOne({ _id: vendorId }, { $set: fields });
    return fields;
  }

  /**
   * Kitchens without any food category (e.g. a category was deleted, or they
   * registered with a client that sent none) get their type's defaults.
   * Kitchens that already have categories are left as they are.
   */
  async backfillMissing() {
    const vendors = await Vendor.find(
      { $or: [{ food_category_ids: { $exists: false } }, { food_category_ids: { $size: 0 } }] },
      { vendor_type: 1 }
    ).lean();
    let filled = 0;
    for (const vendor of vendors) {
      const fields = await this.fieldsFor(vendor.vendor_type);
      if (!fields.food_category_ids.length) continue;
      await Vendor.updateOne({ _id: vendor._id }, { $set: fields });
      filled += 1;
    }
    return filled;
  }
}

module.exports = new VendorCategoryService();
