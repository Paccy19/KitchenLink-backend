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

const verifyTwoFactor = asyncHandler(async (req, res) => {
  res.json(
    await adminAuthService.verifyTwoFactor({
      challenge_token: req.body?.challenge_token,
      code: req.body?.code,
    })
  );
});

const me = asyncHandler(async (req, res) => {
  res.json(await adminAuthService.me(req.admin));
});

const changePassword = asyncHandler(async (req, res) => {
  res.json(
    await adminAuthService.changePassword(req.admin, {
      current_password: req.body?.current_password,
      new_password: req.body?.new_password,
      currentToken: req.tokenPayload,
    })
  );
});

const startTwoFactor = asyncHandler(async (req, res) => {
  res.json(await adminAuthService.startTwoFactor(req.admin, { phone: req.body?.phone }));
});

const enableTwoFactor = asyncHandler(async (req, res) => {
  res.json(
    await adminAuthService.enableTwoFactor(req.admin, { phone: req.body?.phone, code: req.body?.code })
  );
});

const disableTwoFactor = asyncHandler(async (req, res) => {
  res.json(await adminAuthService.disableTwoFactor(req.admin, { code: req.body?.code }));
});

const sendActionCode = asyncHandler(async (req, res) => {
  res.json(await adminAuthService.sendActionCode(req.admin, { purpose: req.body?.purpose }));
});

module.exports = {
  login,
  verifyTwoFactor,
  me,
  changePassword,
  startTwoFactor,
  enableTwoFactor,
  disableTwoFactor,
  sendActionCode,
};
