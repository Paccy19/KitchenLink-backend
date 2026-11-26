const asyncHandler = require('../utils/asyncHandler');
const vendorAuthService = require('../services/vendorAuthService');

const register = asyncHandler(async (req, res) => {
  res.status(201).json(
    await vendorAuthService.register(req.body, req.files || {})
  );
});

const sendOtp = asyncHandler(async (req, res) => {
  const result = await vendorAuthService.sendLoginOtp(req.body || {});
  res.json(result);
});

const verifyOtp = asyncHandler(async (req, res) => {
  const result = await vendorAuthService.verifyLoginOtp(req.body || {});
  res.json(result);
});

const staffLogin = asyncHandler(async (req, res) => {
  res.json(await vendorAuthService.staffPasswordLogin(req.body || {}));
});

const me = asyncHandler(async (req, res) => {
  res.json(vendorAuthService.me(req.vendor, req.kitchenAccess));
});

const changePassword = asyncHandler(async (req, res) => {
  res.json(
    await vendorAuthService.changePassword(req.vendor, {
      current_password: req.body?.current_password,
      new_password: req.body?.new_password,
      currentToken: req.tokenPayload,
      staff: req.staff || null,
    })
  );
});

module.exports = { register, sendOtp, verifyOtp, staffLogin, me, changePassword };
