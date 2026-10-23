const config = require('../config');
const ApiError = require('../utils/ApiError');
const {
  parseRequiredText,
  parseOptionalText,
  parseNonNegativeInt,
  parseObjectId,
  parseBooleanQuery,
} = require('../utils/adminValidators');
const categoryRepository = require('../repositories/categoryRepository');
const adminActionLogService = require('./adminActionLogService');

const serializeAdminCategory = (category) => ({
  id: String(category._id),
  name: category.name,
  icon_url: category.icon_url || null,
  description: category.description || '',
  sort_order: category.sort_order ?? 0,
  is_active: category.is_active !== false,
  // Kitchen that created it (null when an admin did).
  created_by_vendor: category.created_by_vendor_id
    ? { id: String(category.created_by_vendor_id), name: category.created_by_vendor_name || 'A kitchen' }
    : null,
  created_at: category.created_at,
  updated_at: category.updated_at,
});

class AdminCategoryService {
  async list() {
    const categories = await categoryRepository.findAll(200);
    return { items: categories.map(serializeAdminCategory) };
  }

  async create(body = {}, admin, req) {
    const name = parseRequiredText(body.name, { field: 'name', min: 2, max: 60 });
    const existing = await categoryRepository.findByName(name);
    if (existing) {
      throw ApiError.conflict('A category with this name already exists.', 'CATEGORY_EXISTS');
    }

    const category = await categoryRepository.create({
      name,
      icon_url: parseOptionalText(body.icon_url, { field: 'icon_url', max: 500 }) || '',
      description: parseOptionalText(body.description, { field: 'description', max: 300 }) || '',
      sort_order:
        parseNonNegativeInt(body.sort_order, 'sort_order', { max: 9999 }) ?? 0,
      is_active:
        body.is_active === undefined
          ? true
          : parseBooleanQuery(body.is_active, { field: 'is_active' }),
    });

    await adminActionLogService.record(
      admin,
      {
        action: 'category.create',
        target_type: 'category',
        target_id: category._id,
        target_label: category.name,
      },
      req
    );

    return { category: serializeAdminCategory(category) };
  }

  async update(categoryId, body = {}, admin, req) {
    parseObjectId(categoryId, 'category_id');
    const existing = await categoryRepository.findById(categoryId);
    if (!existing) {
      throw ApiError.notFound('Category not found.', 'CATEGORY_NOT_FOUND');
    }

    const payload = {};
    if (body.name !== undefined) {
      const name = parseRequiredText(body.name, { field: 'name', min: 2, max: 60 });
      const clash = await categoryRepository.findByName(name);
      if (clash && String(clash._id) !== String(categoryId)) {
        throw ApiError.conflict('A category with this name already exists.', 'CATEGORY_EXISTS');
      }
      payload.name = name;
    }
    if (body.icon_url !== undefined) {
      payload.icon_url = parseOptionalText(body.icon_url, { field: 'icon_url', max: 500 }) || '';
    }
    if (body.description !== undefined) {
      payload.description =
        parseOptionalText(body.description, { field: 'description', max: 300 }) || '';
    }
    if (body.sort_order !== undefined) {
      payload.sort_order = parseNonNegativeInt(body.sort_order, 'sort_order', { max: 9999 });
    }
    if (body.is_active !== undefined) {
      payload.is_active = parseBooleanQuery(body.is_active, { field: 'is_active' });
    }

    if (Object.keys(payload).length === 0) {
      throw ApiError.badRequest('No changes provided.', {
        category: 'provide at least one field to update',
      });
    }

    const updated = await categoryRepository.update(categoryId, payload);

    await adminActionLogService.record(
      admin,
      {
        action: 'category.update',
        target_type: 'category',
        target_id: categoryId,
        target_label: updated.name,
        metadata: payload,
      },
      req
    );

    return { category: serializeAdminCategory(updated) };
  }

  async remove(categoryId, { force } = {}, admin, req) {
    parseObjectId(categoryId, 'category_id');
    const existing = await categoryRepository.findById(categoryId);
    if (!existing) {
      throw ApiError.notFound('Category not found.', 'CATEGORY_NOT_FOUND');
    }

    const usage = await categoryRepository.countVendorsUsing(categoryId);
    if (usage > 0 && !force) {
      throw ApiError.conflict(
        `This category is used by ${usage} vendor(s). Deactivate it or force delete.`,
        'CATEGORY_IN_USE'
      );
    }

    await categoryRepository.remove(categoryId);
    await adminActionLogService.record(
      admin,
      {
        action: 'category.delete',
        target_type: 'category',
        target_id: categoryId,
        target_label: existing.name,
        metadata: { vendors_using: usage, forced: Boolean(force) },
      },
      req
    );
    return { deleted: true };
  }

  async reorder(items = [], admin, req) {
    if (!Array.isArray(items) || items.length === 0) {
      throw ApiError.badRequest('items is required.', {
        items: 'expected an array of { id, sort_order }',
      });
    }

    const updated = [];
    for (const item of items) {
      parseObjectId(item.id, 'id');
      const sortOrder = parseNonNegativeInt(item.sort_order, 'sort_order', { max: 9999 }) ?? 0;
      const category = await categoryRepository.update(item.id, { sort_order: sortOrder });
      if (category) updated.push(serializeAdminCategory(category));
    }

    await adminActionLogService.record(
      admin,
      {
        action: 'category.reorder',
        target_type: 'category',
        target_id: '',
        target_label: `${updated.length} categories`,
      },
      req
    );

    return { items: updated };
  }
}

module.exports = new AdminCategoryService();
