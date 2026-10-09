const asyncHandler = require('../utils/asyncHandler');
const vendorAuthService = require('../services/vendorAuthService');

const register = asyncHandler(async (req, res) => {
  res.status(201).json(
    await vendorAuthService.register(req.body, req.files || {})
  );
});

const sendOtp = asyncHandler(async (req, res) => {
  const result = await vendorAuthService.sendLoginOtp({
    phone: req.body?.phone,
  });
  res.json(result);
});

const verifyOtp = asyncHandler(async (req, res) => {
  const result = await vendorAuthService.verifyLoginOtp({
    phone: req.body?.phone,
    code: req.body?.code,
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

module.exports = { register, sendOtp, verifyOtp, me, changePassword };
