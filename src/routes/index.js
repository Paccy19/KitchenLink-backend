const { Router } = require('express');
const homeRoutes = require('./homeRoutes');
const geoRoutes = require('./geoRoutes');
const vendorRoutes = require('./vendorRoutes');
const vendorAuthRoutes = require('./vendorAuthRoutes');
const vendorDashboardRoutes = require('./vendorDashboardRoutes');
const vendorMenuRoutes = require('./vendorMenuRoutes');
const vendorOrderRoutes = require('./vendorOrderRoutes');
const vendorWalletRoutes = require('./vendorWalletRoutes');
const vendorNotificationRoutes = require('./vendorNotificationRoutes');
const authRoutes = require('./authRoutes');
const wishlistRoutes = require('./wishlistRoutes');
const cartRoutes = require('./cartRoutes');
const orderRoutes = require('./orderRoutes');
const notificationRoutes = require('./notificationRoutes');
const driverAuthRoutes = require('./driverAuthRoutes');
const driverRoutes = require('./driverRoutes');
const internalDeliveryRoutes = require('./internalDeliveryRoutes');
const adminAuthRoutes = require('./adminAuthRoutes');
const adminRoutes = require('./adminRoutes');
const { customerChatRoutes, vendorChatRoutes } = require('./chatRoutes');

const {
  customerSupportRoutes,
  vendorSupportRoutes,
  driverSupportRoutes,
} = require('./supportRoutes');

const router = Router();

// Banks for withdrawals, with each bank's account-number length (public list).
router.get('/banks', (req, res) => {
  res.json(require('../services/bankSettingsService').list());
});

router.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

router.use('/', homeRoutes);
router.use('/geo', geoRoutes);
router.use('/', vendorRoutes);
router.use('/', authRoutes);
router.use('/', wishlistRoutes);
router.use('/', cartRoutes);
router.use('/vendor/auth', vendorAuthRoutes);
router.use('/vendor/menu', vendorMenuRoutes);
router.use('/vendor/orders', vendorOrderRoutes);
router.use('/vendor/wallet', vendorWalletRoutes);
router.use('/vendor/notifications', vendorNotificationRoutes);
router.use('/vendor/support', vendorSupportRoutes);
router.use('/vendor/chats', vendorChatRoutes);
router.use('/vendor', vendorDashboardRoutes);
router.use('/orders', orderRoutes);
router.use('/notifications', notificationRoutes);
router.use('/support', customerSupportRoutes);
router.use('/chats', customerChatRoutes);
router.use('/driver/auth', driverAuthRoutes);
router.use('/driver/support', driverSupportRoutes);
router.use('/driver', driverRoutes);
router.use('/internal/deliveries', internalDeliveryRoutes);
router.use('/admin/auth', adminAuthRoutes);
router.use('/admin', adminRoutes);

// Discovery routes remain public; customer routes apply authentication locally.

module.exports = router;
