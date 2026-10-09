const { Router } = require('express');
const requireVendorAuth = require('../middleware/requireVendorAuth');
const vendorWalletController = require('../controllers/vendorWalletController');

const router = Router();

router.use(requireVendorAuth);

router.get('/', vendorWalletController.getWallet);
router.post('/withdrawals', vendorWalletController.requestWithdrawal);

module.exports = router;
