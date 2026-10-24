const fs = require('fs');
const path = require('path');
const ApiError = require('../utils/ApiError');
const { Vendor } = require('../models');
const { isPrivateRef, privateFilePath, moveToPrivate } = require('../utils/uploads');

/**
 * Verification documents (IDs, licences, permits) are private: they live in
 * the private uploads folder, which is never served publicly, and are only
 * sent through signed-in endpoints (admins with vendors:read, or the kitchen
 * itself). Documents given as an outside link stay links.
 */
class PrivateDocumentsService {
  /** The vendor's document number `index` as a file to send, or a link to redirect to. */
  fileFor(vendor, rawIndex) {
    const index = Number(rawIndex);
    const doc = Number.isInteger(index) ? (vendor?.verification_documents || [])[index] : null;
    if (!doc) throw ApiError.notFound('Document not found.', 'DOCUMENT_NOT_FOUND');
    if (!isPrivateRef(doc.url)) return { link: doc.url };
    const filePath = privateFilePath(doc.url);
    if (!filePath || !fs.existsSync(filePath)) {
      throw ApiError.notFound('This document file is missing.', 'DOCUMENT_FILE_MISSING');
    }
    return { filePath, label: doc.label || `Document ${index + 1}` };
  }

  /** Sends a document: never cached, shown inline (image or PDF). */
  send(res, vendor, index) {
    const found = this.fileFor(vendor, index);
    if (found.link) return res.redirect(found.link);
    res.set('Cache-Control', 'private, no-store');
    const name = `${found.label.replace(/[^\w .-]+/g, '').trim() || 'document'}${path.extname(found.filePath)}`;
    res.set('Content-Disposition', `inline; filename="${name}"`);
    return res.sendFile(found.filePath);
  }

  /**
   * One-time move of documents uploaded before they were private: files still
   * in the public uploads folder go to the private one, so old links stop
   * working. Safe to run on every start.
   */
  async migratePublicDocuments() {
    const vendors = await Vendor.find({ 'verification_documents.0': { $exists: true } })
      .select('verification_documents')
      .lean();
    let moved = 0;
    for (const vendor of vendors) {
      let changed = false;
      const documents = vendor.verification_documents.map((doc) => {
        if (isPrivateRef(doc.url)) return doc;
        const ref = moveToPrivate(doc.url);
        if (!ref) return doc;
        changed = true;
        moved += 1;
        return { ...doc, url: ref };
      });
      if (changed) await Vendor.updateOne({ _id: vendor._id }, { $set: { verification_documents: documents } });
    }
    return moved;
  }
}

module.exports = new PrivateDocumentsService();
