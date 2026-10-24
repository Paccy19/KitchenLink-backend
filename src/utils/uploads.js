const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const ApiError = require('./ApiError');
const { detectMime } = require('./fileSignature');
const { stripImageMetadata } = require('./imageMetadata');

const uploadsDir = path.isAbsolute(config.vendor.uploads.dir)
  ? config.vendor.uploads.dir
  : path.join(process.cwd(), config.vendor.uploads.dir);

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const ensureUploadsDir = () => {
  fs.mkdirSync(uploadsDir, { recursive: true });
  return uploadsDir;
};

// Private files (verification documents) are stored as "private:<filename>"
// and live outside the public folder.
const privateUploadsDir = path.isAbsolute(config.vendor.uploads.privateDir)
  ? config.vendor.uploads.privateDir
  : path.join(process.cwd(), config.vendor.uploads.privateDir);
const PRIVATE_REF = 'private:';

const ensurePrivateUploadsDir = () => {
  fs.mkdirSync(privateUploadsDir, { recursive: true });
  return privateUploadsDir;
};

const isSafeFilename = (filename) =>
  Boolean(filename) && filename === path.basename(filename) && /^[A-Za-z0-9._-]+$/.test(filename);

const privateRef = (filename) => `${PRIVATE_REF}${filename}`;
const isPrivateRef = (url) => typeof url === 'string' && url.startsWith(PRIVATE_REF);

/** Full path of a private file, or null when the reference isn't a plain filename. */
const privateFilePath = (ref) => {
  if (!isPrivateRef(ref)) return null;
  const filename = ref.slice(PRIVATE_REF.length);
  return isSafeFilename(filename) ? path.join(privateUploadsDir, filename) : null;
};

const buildPublicUrl = (filename) =>
  `${config.publicBaseUrl}${config.vendor.uploads.publicPath}/${filename}`;

const localUrlPrefix = `${config.publicBaseUrl}${config.vendor.uploads.publicPath}/`;
const publicUrlPrefix = `${config.vendor.uploads.publicPath}/`;

/**
 * Deletes a locally stored upload referenced by its public URL.
 * External URLs and already-missing files are ignored; never throws.
 * Returns true only when a local file was removed.
 */
/** The filename of a file in the public uploads folder, from its URL (null otherwise). */
const publicUploadFilename = (url) => {
  if (typeof url !== 'string' || !url) return null;
  let filename;
  if (url.startsWith(localUrlPrefix)) filename = url.slice(localUrlPrefix.length);
  else if (url.startsWith(publicUrlPrefix)) filename = url.slice(publicUrlPrefix.length);
  else return null;
  // Reject anything that is not a plain filename (no traversal, no subpaths).
  return isSafeFilename(filename) ? filename : null;
};

/** Moves a public upload into the private folder; returns its private reference (null if not local). */
const moveToPrivate = (url) => {
  const filename = publicUploadFilename(url);
  if (!filename) return null;
  const from = path.join(uploadsDir, filename);
  if (!fs.existsSync(from)) return null;
  fs.renameSync(from, path.join(ensurePrivateUploadsDir(), filename));
  return privateRef(filename);
};

const deleteLocalUpload = (url) => {
  const filename = publicUploadFilename(url);
  if (!filename) return false;

  try {
    fs.unlinkSync(path.join(uploadsDir, filename));
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`[uploads] could not remove ${filename}: ${error.message}`);
    }
    return false;
  }
};

const writeBuffer = (buffer, ext, { isPrivate = false } = {}) => {
  ensureUploadsDir();
  const filename = `upload-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  if (isPrivate) {
    fs.writeFileSync(path.join(ensurePrivateUploadsDir(), filename), buffer);
    return privateRef(filename);
  }
  fs.writeFileSync(path.join(uploadsDir, filename), buffer);
  return buildPublicUrl(filename);
};

const saveDataUri = async (dataUri, { isPrivate = false } = {}) => {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(String(dataUri).trim());
  if (!match) {
    throw ApiError.badRequest('image_base64 must be a valid image data URI.', {
      image: 'expected data:image/<type>;base64,<data>',
    });
  }
  const [, mime, base64] = match;
  if (!config.vendor.uploads.allowedMimeTypes.includes(mime)) {
    throw ApiError.badRequest('Unsupported image type.', {
      image: `allowed: ${config.vendor.uploads.allowedMimeTypes.join(', ')}`,
    });
  }
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0 || buffer.length > config.vendor.uploads.maxFileSizeBytes) {
    throw ApiError.badRequest('Image is empty or too large.', {
      image: `maximum size is ${Math.round(config.vendor.uploads.maxFileSizeBytes / (1024 * 1024))}MB`,
    });
  }
  // The data must really be the image type it claims (not e.g. a script).
  if (detectMime(buffer) !== mime) {
    throw ApiError.badRequest('This file is not a real image.', { image: 'file content does not match its type' });
  }
  // Saved without hidden metadata (GPS location, camera, date).
  return writeBuffer(await stripImageMetadata(buffer, mime), EXT_BY_MIME[mime] || '', { isPrivate });
};

/**
 * Resolves an image reference from a request (a promise).
 * Priority: multipart upload -> base64 data URI -> plain URL.
 * Returns undefined when no image was supplied. Uploaded images are saved
 * without metadata (multipart ones by the upload middleware). `isPrivate`
 * keeps the photo out of the public folder (e.g. delivery proof photos).
 */
const resolveImageUrl = async ({ file, image_url, image_base64, isPrivate = false } = {}) => {
  if (file) return isPrivate ? moveToPrivate(buildPublicUrl(file.filename)) : buildPublicUrl(file.filename);

  const candidate = image_base64 || image_url;
  if (candidate === undefined || candidate === null || candidate === '') {
    return undefined;
  }
  if (typeof candidate === 'string' && candidate.startsWith('data:')) {
    return saveDataUri(candidate, { isPrivate });
  }
  const url = String(candidate).trim();
  if (url.length > 2048) {
    throw ApiError.badRequest('image_url is too long.', {
      image_url: 'maximum length is 2048 characters',
    });
  }
  // Only web links (or our own /uploads paths): no javascript:, data:, file: ...
  if (url && !/^https?:\/\//i.test(url) && !url.startsWith(publicUrlPrefix)) {
    throw ApiError.badRequest('image_url must be an http or https link.', { image_url: 'expected http(s)://...' });
  }
  return url || undefined;
};

module.exports = {
  uploadsDir,
  ensureUploadsDir,
  privateUploadsDir,
  ensurePrivateUploadsDir,
  privateRef,
  isPrivateRef,
  privateFilePath,
  moveToPrivate,
  buildPublicUrl,
  resolveImageUrl,
  deleteLocalUpload,
};
