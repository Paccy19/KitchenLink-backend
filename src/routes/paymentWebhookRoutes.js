const { Router } = require('express');
const paypackService = require('../services/paypackService');
const orderService = require('../services/orderService');
const tablePaymentService = require('../services/kitchen/tablePaymentService');

/**
 * Paypack reports each mobile money payment here (POST /api/v1/payments/paypack/webhook).
 * Only a valid X-Paypack-Signature is trusted; the same report twice changes nothing.
 */
const router = Router();

router.post('/paypack/webhook', async (req, res) => {
  if (!paypackService.verifySignature(req.rawBody, req.get('x-paypack-signature'))) {
    return res.status(401).json({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid webhook signature.' } });
  }
  const data = req.body?.data || {};
  if (data.ref && String(data.kind || 'CASHIN').toUpperCase() === 'CASHIN') {
    try {
      const status = paypackService.statusOf(data.status);
      const settledSeatPayment = await tablePaymentService.settleProviderPayment(String(data.ref), status);
      if (!settledSeatPayment) await orderService.settleProviderPayment(String(data.ref), status);
    } catch (error) {
      console.error('[payments] Paypack webhook failed:', error.message);
      return res.status(500).json({ error: { code: 'WEBHOOK_FAILED', message: 'Try again.' } });
    }
  }
  return res.json({ received: true });
});

module.exports = router;
