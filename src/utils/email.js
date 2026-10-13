/**
 * Email delivery. Uses the SMTP account in config.mail (SMTP_HOST, SMTP_PORT,
 * SMTP_USER, SMTP_PASS, MAIL_FROM). Without SMTP_HOST nothing is sent: the
 * message is logged in development and `status: 'skipped'` is returned so the
 * caller can offer another way (e.g. a link to copy).
 *
 * @module utils/email
 */
const nodemailer = require('nodemailer');
const config = require('../config');

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

/**
 * @param {{to:string, subject:string, text:string, html?:string}} message
 * @returns {Promise<{status:'sent'|'skipped'|'failed', error?:string}>}
 */
async function sendEmail({ to, subject, text, html }) {
  if (!config.mail.host) {
    if (config.env !== 'production') console.log(`[email] to ${to}: ${subject}\n${text}`);
    return { status: 'skipped' };
  }
  try {
    await getTransporter().sendMail({ from: config.mail.from, to, subject, text, html });
    return { status: 'sent' };
  } catch (error) {
    console.error('[email] failed:', error.message);
    return { status: 'failed', error: error.message };
  }
}

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

module.exports = { sendEmail, escapeHtml };
