const ApiError = require('../utils/ApiError');
const config = require('../config');
const { parseQuantity } = require('../utils/validators');
const cartRepository = require('../repositories/cartRepository');
const menuItemRepository = require('../repositories/menuItemRepository');

const deliveryFee = (subtotalRwf) =>
  subtotalRwf >= config.orders.freeDeliveryOverRwf ? 0 : config.orders.deliveryFeeRwf;

const serializeCartEntry = (entry) => {
  const item = entry.menu_item_id;
  const vendor = entry.vendor_id;
  return {
    id: String(entry._id),
    menu_item_id: String(item._id),
    name: item.name,
    description: item.description || '',
    price_rwf: item.price_rwf,
    quantity: entry.quantity,
    subtotal_rwf: item.price_rwf * entry.quantity,
    image_url: item.image_url || null,
    is_available: Boolean(item.is_available),
    vendor_id: String(item.vendor_id),
    vendor_name: vendor?.name ?? null,
  };
};

class CartService {
  async getCart(customerId) {
    const entries = (await cartRepository.list(customerId)).filter(
      (entry) => entry.menu_item_id
    );

    const items = entries.map(serializeCartEntry);
    const subtotal = items.reduce((sum, item) => sum + item.subtotal_rwf, 0);
    const fee = deliveryFee(subtotal);
    const vendor = entries[0]?.vendor_id ?? null;

    return {
      vendor: vendor
        ? {
            id: String(vendor._id),
            name: vendor.name,
            vendor_type: vendor.vendor_type,
            banner_image_url: vendor.banner_image_url || null,
            delivery_available: Boolean(vendor.delivery_available),
          }
        : null,
      items,
      item_count: items.reduce((sum, item) => sum + item.quantity, 0),
      subtotal_rwf: subtotal,
      delivery_fee_rwf: fee,
      total_rwf: subtotal + fee,
    };
  }

  async assertVendorCompatible(customerId, vendorId) {
    const others = await cartRepository.findOtherVendorItems(customerId, vendorId);
    if (others.length > 0) {
      throw ApiError.conflict(
        `Your cart already has items from ${others[0].vendor_id?.name ?? 'another kitchen'}. Clear it before adding items from a different kitchen.`,
        'CART_VENDOR_CONFLICT'
      );
    }
  }

  async add(customerId, rawMenuItemId, rawQuantity) {
    const menuItemId = String(rawMenuItemId);
    const quantity = parseQuantity(rawQuantity, { required: false });

    const menuItem = await menuItemRepository.findById(menuItemId).catch(() => null);
    if (!menuItem) {
      throw ApiError.notFound('Menu item not found.', 'MENU_ITEM_NOT_FOUND');
    }
    if (!menuItem.is_available) {
      throw ApiError.conflict(
        `${menuItem.name} is currently unavailable.`,
        'ITEM_UNAVAILABLE'
      );
    }

    await this.assertVendorCompatible(customerId, menuItem.vendor_id);
    await cartRepository.upsertQuantity(
      customerId,
      menuItemId,
      menuItem.vendor_id,
      quantity
    );

    return this.getCart(customerId);
  }

  async updateQuantity(customerId, rawMenuItemId, rawQuantity) {
    const menuItemId = String(rawMenuItemId);
    const quantity = parseQuantity(rawQuantity, { required: true });

    const existing = await cartRepository.findByCustomerAndItem(customerId, menuItemId);
    if (!existing) {
      throw ApiError.notFound('Item not in cart.', 'CART_ITEM_NOT_FOUND');
    }

    if (quantity > config.limits.cartMaxQuantity) {
      throw ApiError.badRequest(
        `quantity must not exceed ${config.limits.cartMaxQuantity}.`,
        { quantity: `maximum is ${config.limits.cartMaxQuantity}` }
      );
    }

    await cartRepository.setQuantity(customerId, menuItemId, quantity);
    return this.getCart(customerId);
  }

  async removeItem(customerId, menuItemId) {
    const removed = await cartRepository.removeItem(customerId, String(menuItemId));
    if (!removed) {
      throw ApiError.notFound('Item not in cart.', 'CART_ITEM_NOT_FOUND');
    }
    return this.getCart(customerId);
  }

  async clear(customerId) {
    await cartRepository.clear(customerId);
    return this.getCart(customerId);
  }

  async replace(customerId, rawItems) {
    if (!Array.isArray(rawItems) || rawItems.length > 50) {
      throw ApiError.badRequest('items must be an array with at most 50 entries.', {
        items: 'expected an array of menu_item_id and quantity entries',
      });
    }

    const aggregated = new Map();
    for (const rawItem of rawItems) {
      const menuItemId = String(rawItem?.menu_item_id ?? '');
      const quantity = parseQuantity(rawItem?.quantity, { required: false });
      const menuItem = await menuItemRepository.findById(menuItemId).catch(() => null);
      if (!menuItem) {
        throw ApiError.notFound('Menu item not found.', 'MENU_ITEM_NOT_FOUND');
      }
      if (!menuItem.is_available) {
        throw ApiError.conflict(`${menuItem.name} is currently unavailable.`, 'ITEM_UNAVAILABLE');
      }
      const existing = aggregated.get(menuItemId);
      const nextQuantity = (existing?.quantity ?? 0) + quantity;
      if (nextQuantity > config.limits.cartMaxQuantity) {
        throw ApiError.badRequest(
          `quantity must not exceed ${config.limits.cartMaxQuantity}.`,
          { quantity: `maximum is ${config.limits.cartMaxQuantity}` }
        );
      }
      aggregated.set(menuItemId, {
        menu_item_id: menuItem._id,
        vendor_id: menuItem.vendor_id,
        quantity: nextQuantity,
      });
    }

    const entries = [...aggregated.values()];
    if (new Set(entries.map((entry) => String(entry.vendor_id))).size > 1) {
      throw ApiError.conflict(
        'Checkout supports one kitchen at a time. Your cart has items from multiple kitchens.',
        'CART_VENDOR_CONFLICT'
      );
    }

    await cartRepository.replace(customerId, entries);
    return this.getCart(customerId);
  }
}

module.exports = new CartService();
