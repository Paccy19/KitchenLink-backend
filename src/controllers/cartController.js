const asyncHandler = require('../utils/asyncHandler');
const cartService = require('../services/cartService');

const getCart = asyncHandler(async (req, res) => {
  res.json(await cartService.getCart(req.customer._id));
});

const add = asyncHandler(async (req, res) => {
  res.json(
    await cartService.add(
      req.customer._id,
      req.body?.menu_item_id,
      req.body?.quantity
    )
  );
});

const update = asyncHandler(async (req, res) => {
  res.json(
    await cartService.updateQuantity(
      req.customer._id,
      req.params.menu_item_id,
      req.body?.quantity
    )
  );
});

const remove = asyncHandler(async (req, res) => {
  res.json(await cartService.removeItem(req.customer._id, req.params.menu_item_id));
});

const clear = asyncHandler(async (req, res) => {
  res.json(await cartService.clear(req.customer._id));
});

module.exports = { getCart, add, update, remove, clear };
