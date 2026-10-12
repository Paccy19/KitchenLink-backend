const config = require('../config');

/**
 * Payout services that actually move money. The platform starts on `manual`:
 * withdrawals are created and the owner makes the transfer, then confirms it
 * with its reference. A real service (e.g. MTN MoMo Disbursement for phone
 * numbers, or an aggregator such as Flutterwave for bank accounts and mobile
 * money) is added here by implementing `send`, and selected with
 * PAYOUT_PROVIDER in the backend .env. Nothing else needs to change.
 *
 * send({ amountRwf, destination, reference }) resolves to:
 *   { status: 'sent', providerReference }  money is on its way -> completed
 *   { status: 'manual' }                   owner must transfer it by hand
 *   { status: 'failed', error }            nothing was sent -> cancelled
 */
const providers = {
  manual: {
    label: 'Manual transfer',
    automatic: false,
    supports: () => true,
    async send() {
      return { status: 'manual' };
    },
  },
};

function activeProvider() {
  return providers[config.admin.owner.payoutProvider] || providers.manual;
}

module.exports = { activeProvider, providers };
