const asyncHandler = require('../utils/asyncHandler');
const driverAuthService = require('../services/driverAuthService');

const register = asyncHandler(async (req, res) => {
  res.status(201).json(await driverAuthService.register(req.body));
});

const sendOtp = asyncHandler(async (req, res) => {
  res.json(await driverAuthService.sendLoginOtp(req.body || {}));
});

const verifyOtp = asyncHandler(async (req, res) => {
  res.json(
    await driverAuthService.verifyLoginOtp(req.body || {})
  );
});

const me = asyncHandler(async (req, res) => {
  res.json(driverAuthService.me(req.driver));
});

const changePassword = asyncHandler(async (req, res) => {
  res.json(
    await driverAuthService.changePassword(req.driver, {
      current_password: req.body?.current_password,
      new_password: req.body?.new_password,
      currentToken: req.tokenPayload,
    })
  );
});

module.exports = { register, sendOtp, verifyOtp, me, changePassword };
