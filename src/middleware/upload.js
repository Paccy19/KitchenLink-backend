const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');
const ApiError = require('../utils/ApiError');
const { uploadsDir, ensureUploadsDir } = require('../utils/uploads');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      cb(null, ensureUploadsDir());
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : '';
    cb(null, `menu-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${safeExt}`);
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
