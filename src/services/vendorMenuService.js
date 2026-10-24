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

  async list(vendor, query = {}) {
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

    const { items, total } = await menuItemRepository.listByVendor(vendor._id, {
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

  async create(vendor, body = {}, file) {
    const payload = this.#parsePayload(body);
    payload.vendor_id = vendor._id;

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

  async update(vendor, itemId, body = {}, file) {
    const id = parseObjectId(itemId, 'item_id');
    const existing = await menuItemRepository.findByIdForVendor(id, vendor._id);
    if (!existing) {
      throw ApiError.notFound('Menu item not found.', 'MENU_ITEM_NOT_FOUND');
    }

    const payload = this.#parsePayload(body, { partial: true });

    if (body.category_id !== undefined) {
      payload.category_id = (await this.#resolveCategoryId(body.category_id)) ?? null;
    }

    const clearImage = parseBooleanValue(body.image_clear, {
      field: 'image_clear',
      fallback: false,
    });

    // Validate options before writing any new image to disk.
    const options = body.options !== undefined ? parseMenuOptions(body.options) || [] : undefined;

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

  async remove(vendor, itemId, query = {}) {
    const id = parseObjectId(itemId, 'item_id');
    const existing = await menuItemRepository.findByIdForVendor(id, vendor._id);
    if (!existing) {
      throw ApiError.notFound('Menu item not found.', 'MENU_ITEM_NOT_FOUND');
    }

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

  async setAvailability(vendor, itemId, body = {}) {
    const id = parseObjectId(itemId, 'item_id');
    const existing = await menuItemRepository.findByIdForVendor(id, vendor._id);
    if (!existing) {
      throw ApiError.notFound('Menu item not found.', 'MENU_ITEM_NOT_FOUND');
    }

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

  #serializeCategory(category) {
    return { id: String(category._id), name: category.name, icon_url: category.icon_url || null };
  }

  async categories() {
    const categories = await categoryRepository.findAll(config.limits.categories);
    return {
      categories: categories.map((category) => ({
        id: String(category._id),
        name: category.name,
        icon_url: category.icon_url || null,
      })),
    };
  }
}

module.exports = new VendorMenuService();
