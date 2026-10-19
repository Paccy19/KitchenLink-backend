const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');
const ApiError = require('../utils/ApiError');
const { uploadsDir, ensureUploadsDir } = require('../utils/uploads');

// Extension is derived from the (allowlist-validated) MIME type rather than the
// client-supplied filename, so uploads always land with a correct extension and
// a spoofed filename can never change how the file is served.
const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      cb(null, ensureUploadsDir());
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const originalExt = path.extname(file.originalname || '').toLowerCase();
    const safeOriginal = /^\.[a-z0-9]{1,5}$/.test(originalExt) ? originalExt : '';
    const ext = EXT_BY_MIME[file.mimetype] || safeOriginal;
    cb(null, `upload-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

const reject = (cb, allowed) =>
  cb(
    ApiError.badRequest('Unsupported file type.', {
      file: `allowed: ${allowed.join(', ')}`,
    })
  );

/** Menu item images (images only). */
const imageUpload = multer({
  storage,
  limits: { fileSize: config.vendor.uploads.maxFileSizeBytes, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!config.vendor.uploads.allowedMimeTypes.includes(file.mimetype)) {
      return reject(cb, config.vendor.uploads.allowedMimeTypes);
    }
    cb(null, true);
  },
});

/** Verification documents (images or PDF). */
const documentUpload = multer({
  storage,
  limits: {
    fileSize: config.vendor.uploads.maxDocumentSizeBytes,
    files: config.vendor.uploads.maxDocuments,
  },
  fileFilter: (req, file, cb) => {
    if (!config.vendor.uploads.documentMimeTypes.includes(file.mimetype)) {
      return reject(cb, config.vendor.uploads.documentMimeTypes);
    }
    cb(null, true);
  },
});

/**
 * Vendor registration: one banner image plus up to `maxDocuments`
 * verification documents in a single multipart request.
 */
const registrationUpload = multer({
  storage,
  limits: {
    fileSize: config.vendor.uploads.maxDocumentSizeBytes,
    files: config.vendor.uploads.maxDocuments + 1,
  },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'banner_image') {
      if (!config.vendor.uploads.allowedMimeTypes.includes(file.mimetype)) {
        return reject(cb, config.vendor.uploads.allowedMimeTypes);
      }
      return cb(null, true);
    }
    if (!config.vendor.uploads.documentMimeTypes.includes(file.mimetype)) {
      return reject(cb, config.vendor.uploads.documentMimeTypes);
    }
    cb(null, true);
  },
});

module.exports = imageUpload;
module.exports.uploadsDir = uploadsDir;
module.exports.documents = documentUpload;
module.exports.registration = registrationUpload;
