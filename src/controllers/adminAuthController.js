const asyncHandler = require('../utils/asyncHandler');
const adminAuthService = require('../services/adminAuthService');

const login = asyncHandler(async (req, res) => {
  res.json(
    await adminAuthService.login({
      email: req.body?.email,
      password: req.body?.password,
    })
  );
});

const me = asyncHandler(async (req, res) => {
  res.json(adminAuthService.me(req.admin));
});

const changePassword = asyncHandler(async (req, res) => {
  res.json(
    await adminAuthService.changePassword(req.admin, {
      current_password: req.body?.current_password,
      new_password: req.body?.new_password,
    })
  );
});

module.exports = { login, me, changePassword };
