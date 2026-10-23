const ApiError = require('../utils/ApiError');

const normalizeError = (err) => {
  if (err instanceof ApiError) return err;

  if (err?.name === 'CastError') {
    return ApiError.badRequest('Invalid value provided.', {
      [err.path]: err.message,
    });
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
        ? 'Image is too large.'
        : 'Image upload failed.';
    return new ApiError(400, err.code || 'UPLOAD_ERROR', message, {
      image: err.message,
    });
  }

  if (err?.type === 'entity.too.large' || err?.statusCode === 413) {
    return new ApiError(
      413,
      'PAYLOAD_TOO_LARGE',
      'Request payload is too large. Images must be under 5 MB.'
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
    return new ApiError(409, 'DUPLICATE_ENTRY', 'Duplicate value for a unique field.', {
      ...err.keyValue,
    });
  }

  return new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong.');
};

const errorHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  const normalized = normalizeError(err);

  if (normalized.statusCode >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
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
