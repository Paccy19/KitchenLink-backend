const ApiError = require('../utils/ApiError');
const { parseQuantity } = require('../utils/validators');
const wishlistRepository = require('../repositories/wishlistRepository');
const menuItemRepository = require('../repositories/menuItemRepository');
const cartService = require('./cartService');

const serializeWishlistEntry = (entry) => {
  const item = entry.menu_item_id;
  return {
    id: String(entry._id),
    menu_item_id: String(item._id),
    name: item.name,
    price_rwf: item.price_rwf,
    image_url: item.image_url || null,
    is_available: Boolean(item.is_available),
    vendor_id: String(item.vendor_id?._id ?? item.vendor_id),
    vendor_name: item.vendor_id?.name ?? '',
    vendor_type: item.vendor_id?.vendor_type ?? '',
    vendor_neighborhood: item.vendor_id?.neighborhood ?? '',
    delivery_available: Boolean(item.vendor_id?.delivery_available),
    added_at: entry.created_at,
  };
};

class WishlistService {
  async list(customerId) {
    const entries = (await wishlistRepository.list(customerId)).filter(
      (entry) => entry.menu_item_id
    );
    const items = entries.map(serializeWishlistEntry);
    return { items, count: items.length };
  }

  async add(customerId, rawMenuItemId) {
    const menuItemId = String(rawMenuItemId);

    const menuItem = await menuItemRepository.findById(menuItemId).catch(() => null);
    if (!menuItem) {
      throw ApiError.notFound('Menu item not found.', 'MENU_ITEM_NOT_FOUND');
    }

    const existing = await wishlistRepository.findByCustomerAndItem(customerId, menuItemId);
    if (existing) {
      return this.list(customerId);
    }

    await wishlistRepository.add(customerId, menuItemId);
    return this.list(customerId);
  }

  async remove(customerId, rawMenuItemId) {
    const removed = await wishlistRepository.remove(customerId, String(rawMenuItemId));
    if (!removed) {
      throw ApiError.notFound('Item not in your wishlist.', 'NOT_IN_WISHLIST');
    }
    return this.list(customerId);
  }

  async moveToCart(customerId, rawMenuItemId, rawQuantity) {
    const menuItemId = String(rawMenuItemId);
    const quantity = parseQuantity(rawQuantity, { required: false });

    const wishlistEntry = await wishlistRepository.findByCustomerAndItem(customerId, menuItemId);
    if (!wishlistEntry) {
      throw ApiError.notFound('Item not in your wishlist.', 'NOT_IN_WISHLIST');
    }

    const menuItem = await menuItemRepository.findAvailableById(menuItemId).catch(() => null);
    if (!menuItem) {
      throw ApiError.conflict(
        'This item is no longer available and cannot be moved to your cart.',
        'ITEM_UNAVAILABLE'
      );
    }

    // cartService.add performs the vendor-conflict and availability checks
    // before mutating anything, so a failed move keeps the wishlist intact.
    const cart = await cartService.add(customerId, menuItemId, quantity);
    await wishlistRepository.remove(customerId, menuItemId);

    return {
      cart,
      wishlist: await this.list(customerId),
      moved: { menu_item_id: menuItemId, quantity },
    };
  }
}

module.exports = new WishlistService();
