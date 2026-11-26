const config = require('../config');
const ApiError = require('../utils/ApiError');
const parsePagination = require('../utils/pagination');
const { buildPublicUrl, resolveImageUrl, deleteLocalUpload } = require('../utils/uploads');
const {
  parseObjectId,
  parseOptionalText,
  parseRequiredText,
  parsePriceRwf,
  parsePrepTime,
  parseBooleanValue,
  parseMenuOptions,
  parseSort,
  MENU_SORTS,
} = require('../utils/vendorValidators');
const { serializeVendorMenuItem } = require('../utils/serializers');
const menuItemRepository = require('../repositories/menuItemRepository');
const menuItemOptionRepository = require('../repositories/menuItemOptionRepository');
const categoryRepository = require('../repositories/categoryRepository');
const notificationService = require('./notificationService');
const departmentService = require('./kitchen/departmentService');
const mongoose = require('mongoose');

const { Vendor } = require('../models');

const MAX_MENU_PHOTOS = 12;

// The kitchen account when no session access is passed (internal callers).
const OWNER = { can: () => true, assert: () => {}, departmentFilter: () => ({}), isAdmin: true };
const deptOf = (item) => (item?.department_id ? String(item.department_id) : null);

class VendorMenuService {
  async #resolveCategoryId(raw) {
    if (raw === undefined) return undefined;
    if (raw === null || raw === '') return null;
    const id = parseObjectId(raw, 'category_id');
    const category = await categoryRepository.findById(id);
    if (!category) {
      throw ApiError.badRequest('category_id does not exist.', {
        category_id: 'unknown category',
      });
    }
    return id;
  }

  #parsePayload(body = {}, { partial = false } = {}) {
    const payload = {};

    if (!partial || body.name !== undefined) {
      payload.name = parseRequiredText(body.name, {
        field: 'name',
        min: 2,
        max: 80,
      });
    }
    if (!partial || body.price_rwf !== undefined) {
      payload.price_rwf = parsePriceRwf(body.price_rwf);
    }
    if (body.description !== undefined) {
      payload.description =
        parseOptionalText(body.description, { field: 'description', max: 500 }) || '';
    }
    if (body.preparation_time_minutes !== undefined) {
      payload.preparation_time_minutes = parsePrepTime(
        body.preparation_time_minutes
      );
    }
    if (body.is_available !== undefined) {
      payload.is_available = parseBooleanValue(body.is_available, {
        field: 'is_available',
      });
    }
    if (body.is_preorder !== undefined) {
      payload.is_preorder = parseBooleanValue(body.is_preorder, {
        field: 'is_preorder',
      });
    }
    if (body.preorder_cutoff !== undefined) {
      payload.preorder_cutoff =
        parseOptionalText(body.preorder_cutoff, {
          field: 'preorder_cutoff',
          max: 120,
        }) || '';
    }
    if (body.preparation_notes !== undefined) {
      payload.preparation_notes =
        parseOptionalText(body.preparation_notes, { field: 'preparation_notes', max: 300 }) || '';
    }
    if (body.is_popular !== undefined) {
      payload.is_popular = parseBooleanValue(body.is_popular, {
        field: 'is_popular',
      });
    }
    return payload;
  }

  async #withOptions(item) {
    const [options, fresh] = await Promise.all([
      menuItemOptionRepository.findByMenuItem(item._id),
      menuItemRepository.findByIdForVendor(item._id, item.vendor_id),
    ]);
    return serializeVendorMenuItem(fresh || item, options);
  }

  async list(vendor, query = {}, kitchen = OWNER) {
    const { limit, page, offset } = parsePagination(query, {
      defaultLimit: config.vendor.limits.menuDefault,
      maxLimit: config.vendor.limits.menuMax,
    });

    const categoryId = query.category_id
      ? parseObjectId(query.category_id, 'category_id')
      : undefined;
    const isAvailable = parseBooleanValue(query.is_available, {
      field: 'is_available',
      fallback: undefined,
    });
    const q = parseOptionalText(query.q, { field: 'q', max: 100 });
    const sort = parseSort(query.sort, MENU_SORTS);

    // Staff only see the dishes of their departments (menu.view).
    const departmentFilter = { ...kitchen.departmentFilter('menu.view') };
    if (query.department_id === 'none') {
      if (departmentFilter.department_id) departmentFilter.department_id = { $in: [] };
      else departmentFilter.department_id = null;
    } else if (query.department_id && mongoose.isValidObjectId(query.department_id)) {
      kitchen.assert('menu.view', String(query.department_id));
      departmentFilter.department_id = new mongoose.Types.ObjectId(String(query.department_id));
    }
    const { items, total } = await menuItemRepository.listByVendor(vendor._id, {
      departmentFilter,
      categoryId,
      isAvailable,
      q,
      sort,
      limit,
      offset,
    });

    const options = await menuItemOptionRepository.findByMenuItemIds(
      items.map((item) => item._id)
    );
    const optionsByItem = new Map();
    for (const option of options) {
      const key = String(option.menu_item_id);
      if (!optionsByItem.has(key)) optionsByItem.set(key, []);
      optionsByItem.get(key).push(option);
    }

    return {
      items: items.map((item) =>
        serializeVendorMenuItem(item, optionsByItem.get(String(item._id)) || [])
      ),
      meta: { limit, page, offset, total, sort: sort || 'newest' },
    };
  }

  async create(vendor, body = {}, file, kitchen = OWNER) {
    const payload = this.#parsePayload(body);
    payload.vendor_id = vendor._id;
    payload.department_id = (await departmentService.resolveId(vendor._id, body.department_id)) ?? null;
    kitchen.assert('menu.create', payload.department_id ? String(payload.department_id) : null);

    const categoryId = await this.#resolveCategoryId(body.category_id);
    payload.category_id = categoryId ?? null;

    // Validate options before writing the image to disk so a bad payload
    // cannot leave an orphaned upload behind.
    const options = parseMenuOptions(body.options);

    const imageUrl = await resolveImageUrl({
      file,
      image_url: body.image_url,
      image_base64: body.image_base64,
    });
    if (imageUrl !== undefined) payload.image_url = imageUrl;

    try {
      const item = await menuItemRepository.create(payload);

      if (options && options.length > 0) {
        await menuItemOptionRepository.createMany(vendor._id, item._id, options);
      }

      return await this.#withOptions(item);
    } catch (error) {
      if (imageUrl !== undefined) deleteLocalUpload(imageUrl);
      throw error;
    }
  }

  async update(vendor, itemId, body = {}, file, kitchen = OWNER) {
    const id = parseObjectId(itemId, 'item_id');
    const existing = await menuItemRepository.findByIdForVendor(id, vendor._id);
    if (!existing) {
      throw ApiError.notFound('Menu item not found.', 'MENU_ITEM_NOT_FOUND');
    }

    const payload = this.#parsePayload(body, { partial: true });
    if (body.department_id !== undefined) {
      payload.department_id = (await departmentService.resolveId(vendor._id, body.department_id)) ?? null;
    }
    if (body.category_id !== undefined) {
      payload.category_id = (await this.#resolveCategoryId(body.category_id)) ?? null;
    }

    const clearImage = parseBooleanValue(body.image_clear, {
      field: 'image_clear',
      fallback: false,
    });

    // Validate options before writing any new image to disk.
    const options = body.options !== undefined ? parseMenuOptions(body.options) || [] : undefined;

    // Each changed field needs its own permission, for this dish's department
    // (the dashboard sends the whole form, so only real changes count).
    const department = deptOf(existing);
    const need = (permissions, departmentId = department) => {
      if (!permissions.some((permission) => kitchen.can(permission, departmentId))) kitchen.assert(permissions[0], departmentId);
    };
    const differs = (field) => payload[field] !== undefined && String(payload[field] ?? '') !== String(existing[field] ?? '');
    if (['name', 'preparation_time_minutes', 'category_id', 'is_preorder', 'preorder_cutoff', 'preparation_notes'].some(differs)) need(['menu.edit']);
    if (differs('price_rwf')) need(['menu.prices']);
    if (differs('description')) need(['menu.descriptions', 'menu.edit']);
    if (differs('is_available')) need(['menu.availability', 'menu.activate']);
    if (differs('is_popular')) need(['menu.featured']);
    if (differs('department_id')) {
      need(['menu.assign_departments']);
      need(['menu.assign_departments'], payload.department_id ? String(payload.department_id) : null);
    }
    if (clearImage || file || body.image_base64 || (body.image_url !== undefined && body.image_url !== (existing.image_url || ''))) need(['menu.images']);
    if (options !== undefined) {
      const key = (list) => JSON.stringify(list.map((o) => [o.group_name || 'Options', o.name, o.additional_price_rwf || 0]).sort());
      const before = await menuItemOptionRepository.findByMenuItem(id);
      if (key(options) !== key(before)) need(['menu.variants', 'menu.addons']);
    }

    let newImageUrl;
    if (clearImage) {
      payload.image_url = '';
    } else {
      newImageUrl = await resolveImageUrl({
        file,
        image_url: body.image_url,
        image_base64: body.image_base64,
      });
      if (newImageUrl !== undefined) payload.image_url = newImageUrl;
    }

    let updated;
    try {
      updated = await menuItemRepository.update(id, vendor._id, payload);

      if (options !== undefined) {
        await menuItemOptionRepository.replaceForItem(vendor._id, id, options);
      }
    } catch (error) {
      if (newImageUrl !== undefined) deleteLocalUpload(newImageUrl);
      throw error;
    }

    // Remove the previous local file once the new image (or removal) is saved.
    if (existing.image_url && existing.image_url !== updated.image_url) {
      deleteLocalUpload(existing.image_url);
    }

    return this.#withOptions(updated);
  }

  async remove(vendor, itemId, query = {}, kitchen = OWNER) {
    const id = parseObjectId(itemId, 'item_id');
    const existing = await menuItemRepository.findByIdForVendor(id, vendor._id);
    if (!existing) {
      throw ApiError.notFound('Menu item not found.', 'MENU_ITEM_NOT_FOUND');
    }
    kitchen.assert('menu.delete', deptOf(existing));

    const hard = parseBooleanValue(query.hard, {
      field: 'hard',
      fallback: false,
    });

    if (hard) {
      await menuItemOptionRepository.deleteByMenuItem(id);
      await menuItemRepository.hardDelete(id, vendor._id);
      deleteLocalUpload(existing.image_url);
      return { deleted: true, hard: true };
    }

    await menuItemRepository.softDelete(id, vendor._id);
    return { deleted: true, hard: false };
  }

  async setAvailability(vendor, itemId, body = {}, kitchen = OWNER) {
    const id = parseObjectId(itemId, 'item_id');
    const existing = await menuItemRepository.findByIdForVendor(id, vendor._id);
    if (!existing) {
      throw ApiError.notFound('Menu item not found.', 'MENU_ITEM_NOT_FOUND');
    }
    if (!['menu.availability', 'menu.activate'].some((p) => kitchen.can(p, deptOf(existing)))) kitchen.assert('menu.availability', deptOf(existing));

    const isAvailable =
      parseBooleanValue(body.is_available, { field: 'is_available' }) ??
      !existing.is_available;

    const updated = await menuItemRepository.setAvailability(
      id,
      vendor._id,
      isAvailable
    );
    return this.#withOptions(updated);
  }

  // ------------------------------------------------------- menu photos

  #serializePhotos(vendor) {
    return {
      photos: [...(vendor?.menu_photos || [])]
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
        .map((p) => ({ id: String(p._id), url: p.url, caption: p.caption || '', uploaded_at: p.uploaded_at })),
      max: MAX_MENU_PHOTOS,
    };
  }

  async listPhotos(vendor) {
    const fresh = await Vendor.findById(vendor._id).select('menu_photos').lean();
    return this.#serializePhotos(fresh);
  }

  /** POST /vendor/menu/photos (multipart "image", optional "caption"). */
  async addPhoto(vendor, body = {}, file) {
    if (!file) {
      throw ApiError.badRequest('Choose a photo of your menu.', { image: 'expected a multipart file field named "image"' });
    }
    const url = buildPublicUrl(file.filename);
    const caption = parseOptionalText(body.caption, { field: 'caption', max: 80 }) || '';
    // Atomic: never more than the limit, even with two uploads at once.
    const saved = await Vendor.findOneAndUpdate(
      { _id: vendor._id, [`menu_photos.${MAX_MENU_PHOTOS - 1}`]: { $exists: false } },
      { $push: { menu_photos: { url, caption, sort_order: Date.now(), uploaded_at: new Date() } } },
      { returnDocument: 'after' }
    ).select('menu_photos').lean();
    if (!saved) {
      deleteLocalUpload(url);
      throw ApiError.conflict(`You can add up to ${MAX_MENU_PHOTOS} menu photos. Remove one first.`, 'MENU_PHOTO_LIMIT');
    }
    return this.#serializePhotos(saved);
  }

  async updatePhoto(vendor, photoId, body = {}) {
    const id = parseObjectId(photoId, 'photo_id');
    const caption = parseOptionalText(body.caption, { field: 'caption', max: 80 }) || '';
    const saved = await Vendor.findOneAndUpdate(
      { _id: vendor._id, 'menu_photos._id': id },
      { $set: { 'menu_photos.$.caption': caption } },
      { returnDocument: 'after' }
    ).select('menu_photos').lean();
    if (!saved) throw ApiError.notFound('Menu photo not found.', 'MENU_PHOTO_NOT_FOUND');
    return this.#serializePhotos(saved);
  }

  async removePhoto(vendor, photoId) {
    const id = parseObjectId(photoId, 'photo_id');
    const before = await Vendor.findOneAndUpdate(
      { _id: vendor._id, 'menu_photos._id': id },
      { $pull: { menu_photos: { _id: id } } },
      { returnDocument: 'before' }
    ).select('menu_photos').lean();
    if (!before) throw ApiError.notFound('Menu photo not found.', 'MENU_PHOTO_NOT_FOUND');
    const removed = before.menu_photos.find((p) => String(p._id) === String(id));
    if (removed) deleteLocalUpload(removed.url);
    return this.listPhotos(vendor);
  }

  uploadImage(file) {
    if (!file) {
      throw ApiError.badRequest('An image file is required.', {
        image: 'expected a multipart file field named "image"',
      });
    }
    return { image_url: buildPublicUrl(file.filename) };
  }

  /**
   * A kitchen adds a food category with a name of its choice. An existing
   * category with the same name (any letter case) is reused instead. New
   * categories are live straight away; admins are notified and can rename,
   * hide or delete them on the Categories page.
   */
  async createCategory(vendor, body = {}) {
    const name = parseRequiredText(String(body.name ?? '').replace(/\s+/g, ' '), {
      field: 'name',
      min: 2,
      max: 40,
    });
    if (!/^[\p{L}\p{N}][\p{L}\p{N} &'’\-\/,.()]*$/u.test(name)) {
      throw ApiError.badRequest('Use letters, numbers, spaces and & \' - / , . ( ) only.', {
        name: 'expected a plain category name, e.g. Seafood',
      });
    }

    const existing = await categoryRepository.findByName(name);
    if (existing) {
      if (existing.is_active === false) {
        throw ApiError.conflict(
          `"${existing.name}" exists but was hidden by the admin team. Pick another category or contact support.`,
          'CATEGORY_HIDDEN'
        );
      }
      return { category: this.#serializeCategory(existing), created: false };
    }

    const all = await categoryRepository.findAll(1000);
    const category = await categoryRepository.create({
      name,
      sort_order: all.length,
      is_active: true,
      created_by_vendor_id: vendor._id,
      created_by_vendor_name: vendor.name || '',
    });

    notificationService
      .notifyAdmin({
        type: 'category_added',
        title: 'New food category',
        body: `${vendor.name || 'A kitchen'} added the category "${name}".`,
        link: '/admin-dashboard/categories',
        data: { category_id: String(category._id), vendor_id: String(vendor._id), vendor_name: vendor.name || '' },
      })
      .catch(() => null);

    return { category: this.#serializeCategory(category), created: true };
  }

  /**
   * "Edit / Delete product categories": categories are shared by every
   * kitchen, so a kitchen may only change the ones it created, and only
   * while no other kitchen's dishes use them.
   */
  async #ownCategory(vendor, categoryId) {
    const { Category, MenuItem } = require('../models');
    const id = parseObjectId(categoryId, 'category_id');
    const category = await Category.findById(id).lean();
    if (!category) throw ApiError.notFound('Category not found.', 'CATEGORY_NOT_FOUND');
    if (String(category.created_by_vendor_id || '') !== String(vendor._id)) {
      throw ApiError.forbidden('This category is shared on KitchenLink. You can only change categories your kitchen created.', 'CATEGORY_NOT_YOURS');
    }
    const others = await MenuItem.exists({ category_id: id, vendor_id: { $ne: vendor._id }, deleted_at: null });
    if (others) throw ApiError.conflict('Other kitchens use this category now, so it can no longer be changed.', 'CATEGORY_IN_USE');
    return { category, Category, MenuItem };
  }

  async renameCategory(vendor, categoryId, body = {}) {
    const { category, Category } = await this.#ownCategory(vendor, categoryId);
    const name = parseRequiredText(String(body.name ?? '').replace(/\s+/g, ' '), { field: 'name', min: 2, max: 40 });
    const clash = await categoryRepository.findByName(name);
    if (clash && String(clash._id) !== String(category._id)) throw ApiError.conflict(`There is already a category called "${clash.name}".`, 'CATEGORY_EXISTS');
    const saved = await Category.findOneAndUpdate({ _id: category._id }, { $set: { name } }, { returnDocument: 'after' }).lean();
    return { category: this.#serializeCategory(saved) };
  }

  async deleteCategory(vendor, categoryId) {
    const { category, Category, MenuItem } = await this.#ownCategory(vendor, categoryId);
    // This kitchen's dishes in it become uncategorised.
    await MenuItem.updateMany({ vendor_id: vendor._id, category_id: category._id }, { $set: { category_id: null } });
    await Category.deleteOne({ _id: category._id });
    return { deleted: true, id: String(category._id) };
  }

  #serializeCategory(category) {
    return {
      id: String(category._id),
      name: category.name,
      icon_url: category.icon_url || null,
      vendor_types: category.vendor_types || [],
      created_by_vendor_id: category.created_by_vendor_id ? String(category.created_by_vendor_id) : null,
    };
  }

  async categories() {
    const categories = await categoryRepository.findAll(config.limits.categories);
    return {
      categories: categories.map((category) => ({
        id: String(category._id),
        name: category.name,
        icon_url: category.icon_url || null,
        vendor_types: category.vendor_types || [],
        // Which kitchen created it (only that kitchen may rename or delete it).
        created_by_vendor_id: category.created_by_vendor_id ? String(category.created_by_vendor_id) : null,
      })),
    };
  }
}

module.exports = new VendorMenuService();
