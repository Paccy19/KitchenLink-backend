/**
 * Email delivery.
 *
 * Two transports, chosen by config.mail:
 *  1. HTTP API — set EMAIL_PROVIDER (resend | sendgrid | mailgun | brevo) and
 *     EMAIL_API_KEY. Used first when configured.
 *  2. SMTP — set SMTP_HOST/SMTP_PORT/... . Used otherwise.
 *
 * Without either, nothing is sent: the message is logged in development and
 * `status: 'skipped'` is returned so the caller can offer another way (e.g. a
 * link to copy).
 *
 * @module utils/email
 */
const nodemailer = require('nodemailer');
const config = require('../config');

/** Split `Name <email@host>` into a name and an address. */
function parseFrom(from) {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from || '');
  if (match) return { name: match[1].replace(/^"|"$/g, '').trim(), email: match[2].trim() };
  return { name: '', email: String(from || '').trim() };
}

/** Build the HTTP request for the configured provider. */
function buildHttpRequest({ to, subject, text, html }) {
  const from = parseFrom(config.mail.from);
  const provider = config.mail.provider;
  const key = config.mail.apiKey;

  switch (provider) {
    case 'resend':
      return {
        url: config.mail.apiUrl || 'https://api.resend.com/emails',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: { from: config.mail.from, to: [to], subject, text, ...(html ? { html } : {}) },
      };
    case 'sendgrid':
      return {
        url: config.mail.apiUrl || 'https://api.sendgrid.com/v3/mail/send',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: {
          personalizations: [{ to: [{ email: to }] }],
          from: from.name ? { email: from.email, name: from.name } : { email: from.email },
          subject,
          content: [
            { type: 'text/plain', value: text },
            ...(html ? [{ type: 'text/html', value: html }] : []),
          ],
        },
      };
    case 'brevo':
      return {
        url: config.mail.apiUrl || 'https://api.brevo.com/v3/smtp/email',
        headers: { 'api-key': key, 'Content-Type': 'application/json' },
        body: {
          sender: from.name ? { email: from.email, name: from.name } : { email: from.email },
          to: [{ email: to }],
          subject,
          textContent: text,
          ...(html ? { htmlContent: html } : {}),
        },
      };
    case 'mailgun': {
      const domain =
        config.mail.apiUrl ||
        process.env.MAILGUN_DOMAIN ||
        from.email.split('@')[1] ||
        '';
      const form = new URLSearchParams();
      form.set('from', config.mail.from);
      form.set('to', to);
      form.set('subject', subject);
      form.set('text', text);
      if (html) form.set('html', html);
      return {
        url: `https://api.mailgun.net/v3/${domain}/messages`,
        headers: {
          Authorization: `Basic ${Buffer.from(`api:${key}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form,
      };
    }
    default:
      return null;
  }
}

let transporter = null;
const getTransporter = () => {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.secure,
      auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
    });
  }
  return transporter;
};

/** Send through the configured HTTP email API. Returns null when not configured. */
async function sendViaHttp(message) {
  const request = buildHttpRequest(message);
  if (!request) {
    console.error(`[email] unknown EMAIL_PROVIDER "${config.mail.provider}"`);
    return { status: 'failed', error: `unknown provider: ${config.mail.provider}` };
  }
  const init = {
    method: 'POST',
    headers: request.headers,
    body: request.body instanceof URLSearchParams ? request.body.toString() : JSON.stringify(request.body),
  };
  const response = await fetch(request.url, init);
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`${config.mail.provider} ${response.status}: ${detail.slice(0, 200)}`);
  }
  return { status: 'sent' };
}

/**
 * @param {{to:string, subject:string, text:string, html?:string}} message
 * @returns {Promise<{status:'sent'|'skipped'|'failed', error?:string}>}
 */
async function sendEmail(message) {
  const useHttp = Boolean(config.mail.provider && config.mail.apiKey);
  const useSmtp = Boolean(config.mail.host);

  if (!useHttp && !useSmtp) {
    if (config.env !== 'production') console.log(`[email] to ${message.to}: ${message.subject}\n${message.text}`);
    return { status: 'skipped' };
  }

  try {
    if (useHttp) return await sendViaHttp(message);
    await getTransporter().sendMail({ from: config.mail.from, ...message });
    return { status: 'sent' };
  } catch (error) {
    console.error('[email] failed:', error.message);
    return { status: 'failed', error: error.message };
  }
}

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

module.exports = { sendEmail, escapeHtml };
