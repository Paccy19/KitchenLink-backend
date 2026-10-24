/**
 * Settings checked once at startup, all at once, so a live server either
 * starts correctly configured or refuses with the full list of what to fix
 * (instead of features silently breaking later).
 *
 *  - errors: unsafe or broken on a live server; it refuses to start. A server
 *    whose .env explicitly says development/test only warns about them.
 *  - warnings: optional features that are off; the server starts anyway.
 */
const PUBLIC_AGENT_KEYS = ['dev-agent-key'];
const isLocalUrl = (url) => /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(url || '');

function startupReport(config) {
  const errors = [];
  const warnings = [];

  if (config.auth.jwtSecretProblem) {
    errors.push(`JWT_SECRET is ${config.auth.jwtSecretProblem}: set a random string of at least ${config.auth.jwtSecretMinLength} characters`);
  }
  errors.push(...config.databaseProblems);

  const agentKey = process.env.AGENT_API_KEY;
  if (!agentKey || PUBLIC_AGENT_KEYS.includes(agentKey) || agentKey.length < 32) {
    errors.push(
      'AGENT_API_KEY is missing, the public example or shorter than 32 characters: it unlocks the internal endpoints that change order status, so set a private random one'
    );
  }
  if (!process.env.PUBLIC_BASE_URL || isLocalUrl(config.publicBaseUrl)) {
    errors.push('PUBLIC_BASE_URL is not set to the API\'s public address (e.g. https://api.kitchenlink.rw): photo links would point to localhost');
  }
  if (!process.env.FRONTEND_URL || isLocalUrl(config.frontendUrl)) {
    errors.push('FRONTEND_URL is not set to the website\'s address (e.g. https://kitchenlink.rw): invitation links and CORS would point to localhost');
  }
  const sms = config.notifications.sms;
  if (!(sms.enabled && sms.apiUrl && sms.apiKey)) {
    errors.push('No SMS gateway (SMS_ENABLED, SMS_API_URL, SMS_API_KEY): customers, kitchens and drivers could not receive sign-in codes');
  }

  if (config.payments.simulated) {
    warnings.push('No real payment provider is connected: checkout is disabled (simulated payments only run in development)');
  }
  if (!(config.mail.provider && config.mail.apiKey) && !config.mail.host) {
    warnings.push('No email service (EMAIL_PROVIDER + EMAIL_API_KEY, or SMTP_HOST): team invitations are not emailed; the owner gets the link to share instead');
  }
  if (!config.maps.googleApiKey) {
    warnings.push('No GOOGLE_MAPS_API_KEY: routes and place search use the free OpenStreetMap services (fine for light use)');
  }
  if (!config.support?.phone && !config.support?.email) {
    warnings.push('No SUPPORT_PHONE or SUPPORT_EMAIL: customers see no support contact');
  }

  return { errors, warnings };
}

module.exports = { startupReport, PUBLIC_AGENT_KEYS };
