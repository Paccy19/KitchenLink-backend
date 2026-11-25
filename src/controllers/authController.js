const asyncHandler = require('../utils/asyncHandler');
const authService = require('../services/authService');
const unifiedLoginService = require('../services/unifiedLoginService');

// The body is passed as it is: `identifier` (phone or email) or the older
// `phone_number`, the name, and the optional phone of an email sign-up.
const sendOtp = asyncHandler(async (req, res) => {
  res.json(await authService.sendOtp(req.body || {}));
});

const verifyOtp = asyncHandler(async (req, res) => {
  res.json(await authService.verifyOtp(req.body || {}));
});

const sendUnifiedLoginOtp = asyncHandler(async (req, res) => {
  res.json(await unifiedLoginService.sendOtp(req.body || {}));
});

const verifyUnifiedLoginOtp = asyncHandler(async (req, res) => {
  res.json(await unifiedLoginService.verifyOtp(req.body || {}));
});

const me = asyncHandler(async (req, res) => {
  res.json(await authService.me(req.customer));
});

const updateProfile = asyncHandler(async (req, res) => {
  res.json(
    await authService.updateProfile(req.customer, req.body, req.file)
  );
});

const updateLocation = asyncHandler(async (req, res) => {
  res.json(await authService.updateLocation(req.customer, req.body));
});

module.exports = {
  sendOtp,
  verifyOtp,
  sendUnifiedLoginOtp,
  verifyUnifiedLoginOtp,
  me,
  updateProfile,
  updateLocation,
};
