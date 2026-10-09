const config = require('../config');
const ApiError = require('../utils/ApiError');
const parsePagination = require('../utils/pagination');
const { buildPublicUrl, resolveImageUrl } = require('../utils/uploads');
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

    const imageUrl = resolveImageUrl({
      file,
      image_url: body.image_url,
      image_base64: body.image_base64,
    });
    if (imageUrl !== undefined) payload.image_url = imageUrl;

    const item = await menuItemRepository.create(payload);

    const options = parseMenuOptions(body.options);
    if (options && options.length > 0) {
      await menuItemOptionRepository.createMany(vendor._id, item._id, options);
    }

    return this.#withOptions(item);
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

    const imageUrl = resolveImageUrl({
      file,
      image_url: body.image_url,
      image_base64: body.image_base64,
    });
    if (imageUrl !== undefined) payload.image_url = imageUrl;

    const updated = await menuItemRepository.update(id, vendor._id, payload);

    if (body.options !== undefined) {
      const options = parseMenuOptions(body.options) || [];
      await menuItemOptionRepository.replaceForItem(vendor._id, id, options);
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
