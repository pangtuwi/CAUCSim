const express = require('express');

const { deleteObject, presignDownload, assertUploadKey } = require('../lib/s3');
const { scanJobs, invalidate } = require('../lib/jobs');
const { buildUploads, parseUploadKey, metaKeyFor } = require('../lib/uploads');
const { audit } = require('../lib/audit');

const router = express.Router();

// GET /api/admin/uploads
router.get('/uploads', async (req, res, next) => {
  try {
    const snapshot = await scanJobs({ refresh: req.query.refresh === '1' });
    const { files, missing, stale } = await buildUploads(snapshot);

    // "Unused" is about references, not attribution: a file no run points at
    // is reclaimable whether or not an upload record says who put it there.
    // Keying this on attribution === 'orphaned' would make the cleanup list
    // stop growing the moment every new upload carries a sidecar.
    const unused = files.filter((f) => f.runCount === 0);
    const shown = req.query.unused === '1' ? unused : files;

    res.json({
      files: shown,
      total: files.length,
      shown: shown.length,
      unusedCount: unused.length,
      unusedBytes: unused.reduce((total, f) => total + f.size, 0),
      totalBytes: files.reduce((total, f) => total + f.size, 0),
      missing,
      stale,
      scannedAt: snapshot.scannedAt
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/uploads/download?key=uploads/…
router.get('/uploads/download', async (req, res, next) => {
  try {
    const fileKey = assertUploadKey(req.query.key);
    const { originalName } = parseUploadKey(fileKey);
    const url = await presignDownload(fileKey, originalName);
    audit('presign-download', req.admin, { target: fileKey, details: { originalName }, req });
    res.json({ url, filename: originalName });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/uploads?key=uploads/…   body: { confirm: "<name or key>" }
router.delete('/uploads', async (req, res, next) => {
  try {
    const fileKey = assertUploadKey(req.query.key);
    const { originalName } = parseUploadKey(fileKey);
    const snapshot = await scanJobs();
    const usage = snapshot.usageByFileKey.get(fileKey) || null;
    const runCount = usage ? usage.jobIds.length : 0;

    // A file still referenced by runs is confirmed on its full key rather than
    // its display name — a deliberately higher bar for the more consequential
    // delete.
    const expected = runCount > 0 ? fileKey : originalName;
    if (req.body?.confirm !== expected) {
      audit('delete-upload', req.admin, {
        target: fileKey,
        outcome: 'refused',
        details: { reason: 'confirm-mismatch', runCount },
        req
      });
      return res.status(400).json({
        error: runCount > 0
          ? 'Confirmation did not match the file key'
          : 'Confirmation did not match the file name',
        code: 'confirm-mismatch'
      });
    }

    await deleteObject(fileKey);

    // Best effort. S3 deletes are idempotent, so a file with no sidecar needs
    // no existence check, and a failure here must not fail the whole delete.
    let sidecarRemoved = true;
    try {
      await deleteObject(metaKeyFor(fileKey));
    } catch (err) {
      sidecarRemoved = false;
      console.error(`Failed to remove sidecar for ${fileKey}:`, err.message);
    }
    invalidate();

    audit('delete-upload', req.admin, {
      target: fileKey,
      details: { originalName, runCount, sidecarRemoved },
      req
    });

    res.json({ deleted: fileKey, sidecarRemoved, runCount });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
