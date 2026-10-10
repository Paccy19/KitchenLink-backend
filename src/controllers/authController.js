const asyncHandler = require('../utils/asyncHandler');
const authService = require('../services/authService');
const { normalizePhone, parseName } = require('../utils/validators');

const sendOtp = asyncHandler(async (req, res) => {
  const result = await authService.sendOtp({
    phone_number: req.body?.phone_number,
    name: req.body?.name,
  });
  res.json(result);
});

const verifyOtp = asyncHandler(async (req, res) => {
  const result = await authService.verifyOtp({
    phone_number: req.body?.phone_number,
    code: req.body?.code,
    name: req.body?.name,
  });
  res.json(result);
});

const me = asyncHandler(async (req, res) => {
  res.json(await authService.me(req.customer));
});

const updateProfile = asyncHandler(async (req, res) => {
  res.json(
    await authService.updateProfile(req.customer, req.body, req.file)
  );
});

module.exports = { sendOtp, verifyOtp, me, updateProfile };
