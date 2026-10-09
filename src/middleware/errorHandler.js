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

  if (err?.code === 11000) {
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
