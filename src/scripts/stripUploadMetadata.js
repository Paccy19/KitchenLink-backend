/**
 * One-off: removes hidden metadata (EXIF GPS location, camera, date) from
 * images uploaded before the server started doing it, in the public and the
 * private uploads folders. Safe to run again (clean files stay the same).
 *
 *   npm run strip:metadata
 */
const fs = require('fs');
const path = require('path');
const { uploadsDir, privateUploadsDir } = require('../utils/uploads');
const { detectFileMime } = require('../utils/fileSignature');
const { stripImageFileMetadata } = require('../utils/imageMetadata');

(async () => {
  let cleaned = 0;
  let skipped = 0;
  for (const dir of [uploadsDir, privateUploadsDir]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const filePath = path.join(dir, name);
      if (!fs.statSync(filePath).isFile()) continue;
      const mime = detectFileMime(filePath);
      if (!mime || !mime.startsWith('image/')) {
        skipped += 1;
        continue;
      }
      try {
        await stripImageFileMetadata(filePath, mime);
        cleaned += 1;
      } catch (error) {
        console.warn(`  could not clean ${name}: ${error.message}`);
      }
    }
  }
  console.log(`Done: ${cleaned} image(s) saved without metadata; ${skipped} other file(s) left as they are.`);
})();
