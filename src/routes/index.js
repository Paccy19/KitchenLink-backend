const { Router } = require('express');
const homeRoutes = require('./homeRoutes');
const vendorRoutes = require('./vendorRoutes');

const router = Router();

router.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

router.use('/', homeRoutes);
router.use('/', vendorRoutes);

// Future: attach auth middleware for authenticated customer endpoints here.
// Public discovery endpoints above intentionally skip authentication.

module.exports = router;
