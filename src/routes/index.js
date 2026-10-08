const { Router } = require('express');
const homeRoutes = require('./homeRoutes');
const vendorRoutes = require('./vendorRoutes');
const authRoutes = require('./authRoutes');
const wishlistRoutes = require('./wishlistRoutes');
const cartRoutes = require('./cartRoutes');
const orderRoutes = require('./orderRoutes');

const router = Router();

router.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

router.use('/', homeRoutes);
router.use('/', vendorRoutes);
router.use('/', authRoutes);
router.use('/', wishlistRoutes);
router.use('/', cartRoutes);
router.use('/', orderRoutes);

// Future: attach auth middleware for authenticated customer endpoints here.
// Public discovery endpoints above intentionally skip authentication.

module.exports = router;
