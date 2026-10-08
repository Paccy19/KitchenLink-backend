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
}

module.exports = ApiError;
