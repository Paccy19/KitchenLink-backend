const asyncHandler = require('../utils/asyncHandler');
const deliveryService = require('../services/deliveryService');
const driverProfileService = require('../services/driverProfileService');

const updateProfile = asyncHandler(async (req, res) => {
  res.json(
    await driverProfileService.update(req.driver, req.body, req.file)
  );
});

const available = asyncHandler(async (req, res) => {
  res.json(await deliveryService.listAvailable(req.driver, req.query));
});

const accept = asyncHandler(async (req, res) => {
  res.json(await deliveryService.accept(req.driver, req.params.delivery_id));
});

const reject = asyncHandler(async (req, res) => {
  res.json(await deliveryService.reject(req.driver, req.params.delivery_id));
});

const updateStatus = asyncHandler(async (req, res) => {
  res.json(
    await deliveryService.updateStatus(req.driver, req.params.delivery_id, req.body)
  );
});

const confirmDelivery = asyncHandler(async (req, res) => {
  res.json(
    await deliveryService.confirmDelivery(req.driver, req.params.delivery_id, req.body)
  );
});

const active = asyncHandler(async (req, res) => {
  res.json(await deliveryService.getActive(req.driver));
});

const updateLocation = asyncHandler(async (req, res) => {
  res.json(await deliveryService.updateLocation(req.driver, req.body));
});

const setAvailability = asyncHandler(async (req, res) => {
  res.json(await deliveryService.setAvailability(req.driver, req.body));
});

const history = asyncHandler(async (req, res) => {
  res.json(await deliveryService.history(req.driver, req.query));
});

const earnings = asyncHandler(async (req, res) => {
  res.json(await deliveryService.earnings(req.driver, req.query));
});

const stats = asyncHandler(async (req, res) => {
  res.json(await deliveryService.stats(req.driver));
});

module.exports = {
  updateProfile,
  available,
  accept,
  reject,
  updateStatus,
  confirmDelivery,
  active,
  updateLocation,
  setAvailability,
  history,
  earnings,
  stats,
};
