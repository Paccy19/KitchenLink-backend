const ApiError = require('./ApiError');

const MAX_QUERY_LENGTH = 100;
const MAX_TOKENS = 5;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenize(rawQuery) {
  if (typeof rawQuery !== 'string' || rawQuery.trim() === '') {
    throw ApiError.badRequest('q (search query) is required.', {
      q: 'expected a non-empty string',
    });
  }
  const trimmed = rawQuery.trim();
  if (trimmed.length > MAX_QUERY_LENGTH) {
    throw ApiError.badRequest(`q must be at most ${MAX_QUERY_LENGTH} characters.`, {
      q: `maximum length is ${MAX_QUERY_LENGTH}`,
    });
  }
  const tokens = trimmed
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_TOKENS);
  return tokens;
}

const tokenRegex = (token) => new RegExp(escapeRegExp(token), 'i');

/**
 * AND of ORs: every token must match at least one of the given fields.
 * Case-insensitive partial match (regex based - MongoDB has no trigram index).
 */
function buildTokenFilter(tokens, fields) {
  return {
    $and: tokens.map((token) => ({
      $or: fields.map((field) => ({ [field]: tokenRegex(token) })),
    })),
  };
}

module.exports = { escapeRegExp, tokenize, tokenRegex, buildTokenFilter };
