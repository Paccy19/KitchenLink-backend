const fs = require('fs');

/**
 * The real type of a file from its first bytes ("magic numbers"), not from the
 * name or the Content-Type the uploader claimed. Only the types we accept are
 * recognised; anything else is null.
 */
const SIGNATURES = [
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', test: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/gif', test: (b) => ['GIF87a', 'GIF89a'].includes(b.slice(0, 6).toString('latin1')) },
  { mime: 'image/webp', test: (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' },
  { mime: 'application/pdf', test: (b) => b.slice(0, 5).toString('latin1') === '%PDF-' },
];

const detectMime = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  return SIGNATURES.find((signature) => signature.test(buffer))?.mime || null;
};

/** Reads just the start of a saved file to identify it. */
const detectFileMime = (filePath) => {
  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(16);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    return detectMime(head.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
};

module.exports = { detectMime, detectFileMime };
