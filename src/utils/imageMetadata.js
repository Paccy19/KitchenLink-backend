const fs = require('fs');
const sharp = require('sharp');

const FORMATS = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

/**
 * Re-saves an image without its hidden metadata (EXIF: GPS location, camera,
 * date; XMP; comments). Phone photos often carry the exact place they were
 * taken, e.g. a customer's home. JPEGs are first turned the right way up (the
 * EXIF orientation is applied before it is dropped). Same format as before;
 * other types are returned unchanged.
 */
async function stripImageMetadata(buffer, mime) {
  const format = FORMATS[mime];
  if (!format) return buffer;
  const animated = mime === 'image/gif' || mime === 'image/webp';
  let image = sharp(buffer, { animated, failOn: 'error' });
  if (mime === 'image/jpeg') image = image.rotate();
  // sharp writes no metadata unless asked to (no .withMetadata()).
  return image.toFormat(format, format === 'jpeg' ? { quality: 90, mozjpeg: true } : {}).toBuffer();
}

/** Same, for a file already saved on disk (rewritten in place). */
async function stripImageFileMetadata(filePath, mime) {
  if (!FORMATS[mime]) return;
  const clean = await stripImageMetadata(await fs.promises.readFile(filePath), mime);
  await fs.promises.writeFile(filePath, clean);
}

module.exports = { stripImageMetadata, stripImageFileMetadata };
