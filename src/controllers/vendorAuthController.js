const asyncHandler = require('../utils/asyncHandler');
const vendorAuthService = require('../services/vendorAuthService');

const register = asyncHandler(async (req, res) => {
  res.status(201).json(
    await vendorAuthService.register(req.body, req.files || {})
  );
});

const login = asyncHandler(async (req, res) => {
  const result = await vendorAuthService.login({
    name: req.body?.name,
    phone: req.body?.phone,
    email: req.body?.email,
    password: req.body?.password,
  });
  res.json(result);
});

const me = asyncHandler(async (req, res) => {
  res.json(vendorAuthService.me(req.vendor));
});

const changePassword = asyncHandler(async (req, res) => {
  res.json(
    await vendorAuthService.changePassword(req.vendor, {
      current_password: req.body?.current_password,
      new_password: req.body?.new_password,
    })
  );
});

module.exports = { register, login, me, changePassword };
