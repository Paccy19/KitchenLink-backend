const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const ApiError = require('./ApiError');

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

const buildPublicUrl = (filename) =>
  `${config.publicBaseUrl}${config.vendor.uploads.publicPath}/${filename}`;

const localUrlPrefix = `${config.publicBaseUrl}${config.vendor.uploads.publicPath}/`;
const publicUrlPrefix = `${config.vendor.uploads.publicPath}/`;

/**
 * Deletes a locally stored upload referenced by its public URL.
 * External URLs and already-missing files are ignored; never throws.
 * Returns true only when a local file was removed.
 */
const deleteLocalUpload = (url) => {
  if (typeof url !== 'string' || !url) return false;

  let filename;
  if (url.startsWith(localUrlPrefix)) filename = url.slice(localUrlPrefix.length);
  else if (url.startsWith(publicUrlPrefix)) filename = url.slice(publicUrlPrefix.length);
  else return false;

  // Reject anything that is not a plain filename (no traversal, no subpaths).
  if (!filename || filename !== path.basename(filename)) return false;
  if (!/^[A-Za-z0-9._-]+$/.test(filename)) return false;

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

const writeBuffer = (buffer, ext) => {
  ensureUploadsDir();
  const filename = `upload-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(uploadsDir, filename), buffer);
  return buildPublicUrl(filename);
};

const saveDataUri = (dataUri) => {
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
  return writeBuffer(buffer, EXT_BY_MIME[mime] || '');
};

/**
 * Resolves an image reference from a request.
 * Priority: multipart upload -> base64 data URI -> plain URL.
 * Returns undefined when no image was supplied.
 */
const resolveImageUrl = ({ file, image_url, image_base64 } = {}) => {
  if (file) return buildPublicUrl(file.filename);

  const candidate = image_base64 || image_url;
  if (candidate === undefined || candidate === null || candidate === '') {
    return undefined;
  }
  if (typeof candidate === 'string' && candidate.startsWith('data:')) {
    return saveDataUri(candidate);
  }
  const url = String(candidate).trim();
  if (url.length > 2048) {
    throw ApiError.badRequest('image_url is too long.', {
      image_url: 'maximum length is 2048 characters',
    });
  }
  return url || undefined;
};

module.exports = {
  uploadsDir,
  ensureUploadsDir,
  buildPublicUrl,
  resolveImageUrl,
  deleteLocalUpload,
};
