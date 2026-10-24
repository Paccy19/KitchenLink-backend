const ApiError = require('../utils/ApiError');

/**
 * Safety net for every route: refuses requests whose JSON body or query
 * string contains MongoDB operator keys ("$ne", "$gt", "$where", ...) at any
 * depth. Each service still validates its own fields (the parse* helpers);
 * this only guarantees that an endpoint which forgets can't be tricked into
 * running an operator such as { "email": { "$ne": null } } (NoSQL injection).
 * No legitimate request sends such keys.
 */
const MAX_DEPTH = 20;

const findOperatorKey = (value, depth = 0) => {
  if (depth > MAX_DEPTH) return '(nested too deeply)';
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('$')) return key;
    const found = findOperatorKey(child, depth + 1);
    if (found) return found;
  }
  return null;
};

const rejectOperatorKeys = (req, res, next) => {
  const key = findOperatorKey(req.body) || findOperatorKey(req.query);
  if (!key) return next();
  return next(ApiError.badRequest('The request contains a field name that is not allowed.', { [key]: 'not allowed' }));
};

module.exports = rejectOperatorKeys;
