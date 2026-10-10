const { Router } = require('express');
const homeRoutes = require('./homeRoutes');
const vendorRoutes = require('./vendorRoutes');
const vendorAuthRoutes = require('./vendorAuthRoutes');
const vendorDashboardRoutes = require('./vendorDashboardRoutes');
const vendorMenuRoutes = require('./vendorMenuRoutes');
const vendorOrderRoutes = require('./vendorOrderRoutes');
const vendorWalletRoutes = require('./vendorWalletRoutes');
const authRoutes = require('./authRoutes');
const wishlistRoutes = require('./wishlistRoutes');
const cartRoutes = require('./cartRoutes');
const orderRoutes = require('./orderRoutes');
const notificationRoutes = require('./notificationRoutes');
const driverAuthRoutes = require('./driverAuthRoutes');
const driverRoutes = require('./driverRoutes');
const internalDeliveryRoutes = require('./internalDeliveryRoutes');

const router = Router();

router.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

router.use('/', homeRoutes);
router.use('/', vendorRoutes);
router.use('/', authRoutes);
router.use('/', wishlistRoutes);
router.use('/', cartRoutes);
router.use('/vendor/auth', vendorAuthRoutes);
router.use('/vendor/menu', vendorMenuRoutes);
router.use('/vendor/orders', vendorOrderRoutes);
router.use('/vendor/wallet', vendorWalletRoutes);
router.use('/vendor', vendorDashboardRoutes);
router.use('/orders', orderRoutes);
router.use('/notifications', notificationRoutes);
router.use('/driver/auth', driverAuthRoutes);
router.use('/driver', driverRoutes);
router.use('/internal/deliveries', internalDeliveryRoutes);

// Discovery routes remain public; customer routes apply authentication locally.

module.exports = router;
