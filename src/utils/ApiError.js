class ApiError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  static badRequest(message, details) {
    return new ApiError(400, 'VALIDATION_ERROR', message, details);
  }

  static notFound(message, code = 'NOT_FOUND') {
    return new ApiError(404, code, message);
  }

  static unauthorized(message = 'Authentication required.', code = 'UNAUTHORIZED') {
    return new ApiError(401, code, message);
  }

  static forbidden(message = 'Forbidden.', code = 'FORBIDDEN') {
    return new ApiError(403, code, message);
  }

  static conflict(message, code = 'CONFLICT') {
    return new ApiError(409, code, message);
  }

  static tooMany(message, code = 'TOO_MANY_REQUESTS', details) {
    return new ApiError(429, code, message, details);
  }
}

module.exports = ApiError;
