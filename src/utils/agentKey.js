const crypto = require('crypto');
const config = require('../config');
const { PUBLIC_AGENT_KEYS } = require('../config/startupCheck');

/**
 * True when `key` is the agent key (x-agent-key header of internal
 * endpoints). Compared in constant time; the public example key only works on
 * a server whose .env explicitly says development/test.
 */
function isAgentKey(key) {
  const expected = config.orders.agentKey;
  if (typeof key !== 'string' || !key || !expected) return false;
  if (PUBLIC_AGENT_KEYS.includes(expected) && !config.explicitDev) return false;
  const a = crypto.createHash('sha256').update(key).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = isAgentKey;
