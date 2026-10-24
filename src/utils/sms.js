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
const ApiError = require('./ApiError');

const { sms } = config.notifications;

/**
 * @param {string} to   E.164 phone number, e.g. +250788123456
 * @param {string} message
 * @returns {Promise<{status:'sent'|'skipped'|'failed', error?:string}>}
 */
async function sendSms(to, message) {
  if (!sms.enabled || !sms.apiUrl || !sms.apiKey) {
    // Messages hold codes: only printed on an explicit development server.
    if (config.explicitDev) {
      console.log(`[sms] ${to} -> ${message}`);
    }
    return { status: 'skipped' };
  }

  try {
    const response = await fetch(sms.apiUrl, {
      // A slow gateway must not hang sign-in.
      signal: AbortSignal.timeout(10000),
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

/**
 * Sends a sign-in / confirmation code. On a live server the code must really
 * leave: if the gateway fails (down, out of credit, wrong key) `onFail` runs
 * (the caller cancels the code) and the user is told to try again, instead of
 * waiting for a message that never comes. A development server only logs it.
 */
async function sendCodeSms(to, message, { onFail } = {}) {
  const result = await sendSms(to, message);
  if (result.status === 'sent' || config.explicitDev) return result;
  console.error(`[sms] code to ${String(to).slice(0, -4)}**** not delivered: ${result.status}${result.error ? ` (${result.error})` : ''}`);
  if (onFail) await onFail().catch(() => null);
  throw new ApiError(503, 'SMS_NOT_SENT', "We couldn't send the SMS code right now. Please try again in a moment.");
}

module.exports = { sendSms, sendCodeSms };
