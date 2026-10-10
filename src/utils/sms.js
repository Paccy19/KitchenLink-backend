/**
 * SMS delivery abstraction.
 *
 * No SMS gateway is bundled with the project. When `SMS_PROVIDER`/credentials
 * are configured the message is POSTed to the provider's JSON gateway; otherwise
 * it is logged to the server console (`status: 'skipped'`) so the flow stays
 * fully exercisable in development.
 *
 * @module utils/sms
 */

const config = require('../config');

const { sms } = config.notifications;

/**
 * @param {string} to   E.164 phone number, e.g. +250788123456
 * @param {string} message
 * @returns {Promise<{status:'sent'|'skipped'|'failed', error?:string}>}
 */
async function sendSms(to, message) {
  if (!sms.enabled || !sms.apiUrl || !sms.apiKey) {
    if (config.env !== 'production') {
      console.log(`[sms] ${to} -> ${message}`);
    }
    return { status: 'skipped' };
  }

  try {
    const response = await fetch(sms.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(sms.apiKeyHeader ? { [sms.apiKeyHeader]: sms.apiKey } : {}),
      },
      body: JSON.stringify({
        to,
        from: sms.senderId || undefined,
        message,
        ...(sms.apiKeyHeader ? {} : { api_key: sms.apiKey }),
      }),
    });

    if (!response.ok) {
      return { status: 'failed', error: `gateway responded ${response.status}` };
    }
    return { status: 'sent' };
  } catch (error) {
    return { status: 'failed', error: error?.message || 'sms gateway error' };
  }
}

module.exports = { sendSms };
