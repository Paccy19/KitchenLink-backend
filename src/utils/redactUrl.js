/**
 * A request URL safe to write to the logs: secrets carried in the URL (team
 * invitation tokens, and token/code/password query values) are replaced with
 * "[redacted]", so reading the logs never lets anyone use them.
 */
const SECRET_PATH = /(\/invitations\/)[^/?#]+/gi;
const SECRET_QUERY = /([?&](?:token|code|otp|password|secret|key)=)[^&#]*/gi;

const redactUrl = (url = '') => String(url).replace(SECRET_PATH, '$1[redacted]').replace(SECRET_QUERY, '$1[redacted]');

module.exports = redactUrl;
