const crypto = require('crypto');
const config = require('../config');

/**
 * Paypack (https://paypack.rw) collects from MTN MoMo and Airtel Money
 * numbers through one "cashin" call: the customer gets a prompt on their
 * phone, and Paypack reports the result to our webhook (and on request).
 * Same integration as Ikiguzi (MVEC) uses.
 */
const settings = () => config.payments.paypack;
let token = null; // { access, expiresAt }

async function call(method, path, body) {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (path !== '/auth/agents/authorize') {
    headers.Authorization = `Bearer ${await accessToken()}`;
    headers['X-Webhook-Mode'] = settings().webhookMode;
  }
  const res = await fetch(`${settings().baseUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Paypack ${path} failed (${res.status}): ${data.message || JSON.stringify(data)}`);
  return data;
}

async function accessToken() {
  if (token && token.expiresAt > Date.now() + 60_000) return token.access;
  const { access, expires } = await call('POST', '/auth/agents/authorize', {
    client_id: settings().clientId,
    client_secret: settings().clientSecret,
  });
  if (!access) throw new Error('Paypack sent no access token.');
  token = { access, expiresAt: Number(expires) * 1000 || Date.now() + 10 * 60_000 };
  return access;
}

/** 'successful' | 'failed' | 'processing' */
const statusOf = (value) => {
  const s = String(value || '').toLowerCase();
  return s === 'successful' || s === 'success' ? 'successful' : s === 'failed' ? 'failed' : 'processing';
};

/** Sends the payment prompt to a +2507… number. Returns Paypack's transaction ref. */
async function cashin({ amountRwf, phone }) {
  const data = await call('POST', '/transactions/cashin', { amount: amountRwf, number: String(phone).replace(/^\+?250/, '0') });
  return { reference: data.ref, status: statusOf(data.status) };
}

/** The latest status Paypack has for a transaction. */
async function transactionStatus(reference) {
  const data = await call('GET', `/events/transactions?ref=${encodeURIComponent(reference)}`);
  const latest = (data.transactions || [])
    .map((event) => event.data || event)
    .sort((a, b) => new Date(b.processed_at || b.created_at) - new Date(a.processed_at || a.created_at))[0];
  return latest ? statusOf(latest.status) : 'processing';
}

/** X-Paypack-Signature: base64 HMAC-SHA256 of the raw body with the webhook secret. */
function verifySignature(rawBody, signature) {
  const secret = settings().webhookSecret;
  if (!rawBody || !signature || !secret) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(rawBody).digest('base64'));
  const given = Buffer.from(String(signature));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

module.exports = { cashin, transactionStatus, verifySignature, statusOf };
