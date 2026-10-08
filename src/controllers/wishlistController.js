const asyncHandler = require('../utils/asyncHandler');
const wishlistService = require('../services/wishlistService');

const list = asyncHandler(async (req, res) => {
  res.json(await wishlistService.list(req.customer._id));
});

const add = asyncHandler(async (req, res) => {
  res.json(await wishlistService.add(req.customer._id, req.body?.menu_item_id));
});

const remove = asyncHandler(async (req, res) => {
  res.json(await wishlistService.remove(req.customer._id, req.params.menu_item_id));
});

const moveToCart = asyncHandler(async (req, res) => {
  res.json(
    await wishlistService.moveToCart(
      req.customer._id,
      req.params.menu_item_id,
      req.body?.quantity
    )
  );
});

module.exports = { list, add, remove, moveToCart };
