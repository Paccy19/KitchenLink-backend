const ApiError = require('../utils/ApiError');
const redactUrl = require('../utils/redactUrl');

// Clients only ever get our own messages: raw database/library messages
// (model names, internal paths, the values involved) stay in the server log.

const normalizeError = (err) => {
  if (err instanceof ApiError) return err;

  if (err?.name === 'CastError') {
    const field = err.path === '_id' ? 'id' : err.path || 'value';
    return ApiError.badRequest(`Invalid value for ${field}.`, { [field]: 'invalid value' });
  }

  if (err?.name === 'ValidationError') {
    const details = Object.fromEntries(
      Object.entries(err.errors || {}).map(([field, e]) => [field, e.message])
    );
    return ApiError.badRequest('Validation failed.', details);
  }

  if (err?.name === 'MulterError') {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'The file is too large.'
        : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
          ? 'Too many files, or a file was sent in the wrong field.'
          : 'File upload failed.';
    return new ApiError(400, err.code || 'UPLOAD_ERROR', message, err.field ? { [err.field]: message } : undefined);
  }

  // Malformed JSON body: the client's mistake, not a server error.
  if (err?.type === 'entity.parse.failed') {
    return ApiError.badRequest('The request body is not valid JSON.');
  }

  if (err?.type === 'entity.too.large' || err?.statusCode === 413) {
    return new ApiError(
      413,
      'PAYLOAD_TOO_LARGE',
      'The request is too large. Try a smaller photo (photos over about 700 KB are refused).'
    );
  }

  if (err?.code === 11000) {
    // A unique index caught a duplicate (e.g. two sign-ups racing for one phone).
    const field = Object.keys(err.keyValue || err.keyPattern || {})[0] || '';
    if (/phone/.test(field)) {
      return new ApiError(409, 'PHONE_ALREADY_REGISTERED', 'This phone number is already used by another account.', { [field]: 'already registered' });
    }
    if (/email/.test(field)) {
      return new ApiError(409, 'EMAIL_ALREADY_REGISTERED', 'This email is already used by another account.', { [field]: 'already registered' });
    }
    // Only the field name: never echo stored values back.
    return new ApiError(409, 'DUPLICATE_ENTRY', 'This value is already in use.', field ? { [field]: 'already in use' } : undefined);
  }

  return new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong.');
};

const errorHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  const normalized = normalizeError(err);

  // Full details (stack included) go to the server log only, which only the
  // people running the server can read; secrets in the URL are hidden.
  if (normalized.statusCode >= 500) {
    console.error(`[error] ${req.method} ${redactUrl(req.originalUrl)}`, err);
  }

  res.status(normalized.statusCode).json({
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details ? { details: normalized.details } : {}),
    },
  });
};

module.exports = errorHandler;
