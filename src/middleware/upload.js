const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');
const ApiError = require('../utils/ApiError');
const fs = require('fs');
const { uploadsDir, ensureUploadsDir, ensurePrivateUploadsDir } = require('../utils/uploads');
const { detectFileMime } = require('../utils/fileSignature');

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

// Verification documents ("documents" field: IDs, licences) go to the private
// folder, which is never served publicly; images go to the public one.
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      cb(null, file.fieldname === 'documents' ? ensurePrivateUploadsDir() : ensureUploadsDir());
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

/**
 * After multer saved the files: each file's real content (its first bytes)
 * must match the type the uploader claimed, so e.g. a script or web page
 * labelled "image/png" is refused. Every file of the request is deleted when
 * one fails.
 */
const verifyFileContents = (req, res, next) => {
  const files = [
    ...(req.file ? [req.file] : []),
    ...(Array.isArray(req.files) ? req.files : Object.values(req.files || {}).flat()),
  ];
  const bad = files.find((file) => {
    try {
      return detectFileMime(file.path) !== file.mimetype;
    } catch {
      return true;
    }
  });
  if (!bad) return next();
  files.forEach((file) => fs.unlink(file.path, () => {}));
  return next(
    ApiError.badRequest(`"${bad.originalname || bad.fieldname}" is not a real ${EXT_BY_MIME[bad.mimetype]?.slice(1).toUpperCase() || 'supported'} file.`, {
      [bad.fieldname]: 'file content does not match its type',
    })
  );
};

/** A multer instance whose single/fields/array middlewares also verify file contents. */
const withContentCheck = (instance) => ({
  single: (...args) => [instance.single(...args), verifyFileContents],
  fields: (...args) => [instance.fields(...args), verifyFileContents],
  array: (...args) => [instance.array(...args), verifyFileContents],
});

module.exports = withContentCheck(imageUpload);
module.exports.uploadsDir = uploadsDir;
module.exports.documents = withContentCheck(documentUpload);
module.exports.registration = withContentCheck(registrationUpload);
