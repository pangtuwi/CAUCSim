// The uploads/ prefix: STL geometry, and what can be known about who put it there.
//
// Uploads carry no identity of their own. The CFD backend signs a PUT for
// `uploads/<Date.now()>_<sanitised name>` and the browser writes straight to
// S3, so there is nothing in the key, the object metadata, or anywhere else
// saying whose file it is. Two things partly recover that:
//
//  - a sidecar under uploads-meta/, written by the CFD backend when it signs
//    the URL. Authoritative, but only for uploads made since that shipped.
//  - the jobs that reference the fileKey, which tell us who *simulated* the
//    geometry. A good proxy, but a different claim — the UI must say
//    "first simulated by", not "uploaded by".
//
// A file that was never simulated and predates sidecars has no recoverable
// owner. That is a real limit, and the UI states it rather than guessing.
const { listAllObjects, getJson } = require('./s3');
const { mapWithConcurrency } = require('./concurrency');
const { s3Concurrency } = require('./config');

const UPLOAD_PREFIX = 'uploads/';
const META_PREFIX = 'uploads-meta/';

// Sidecars mirror the upload key one-for-one:
//   uploads/1730000000000_car.stl  ->  uploads-meta/1730000000000_car.stl.json
const metaKeyFor = (fileKey) => `${META_PREFIX}${fileKey.slice(UPLOAD_PREFIX.length)}.json`;
const fileKeyForMeta = (metaKey) => `${UPLOAD_PREFIX}${metaKey.slice(META_PREFIX.length).replace(/\.json$/, '')}`;

/** Recover the user's original filename and upload time from the key. */
function parseUploadKey(key) {
  const withoutPrefix = key.slice(UPLOAD_PREFIX.length);
  const separator = withoutPrefix.indexOf('_');
  const stamp = separator === -1 ? NaN : Number(withoutPrefix.slice(0, separator));
  return {
    originalName: separator === -1 ? withoutPrefix : withoutPrefix.slice(separator + 1),
    uploadedAt: Number.isFinite(stamp) && stamp > 0 ? new Date(stamp).toISOString() : null
  };
}

async function buildUploads(snapshot) {
  const [uploadObjects, metaObjects] = await Promise.all([
    listAllObjects(UPLOAD_PREFIX),
    listAllObjects(META_PREFIX)
  ]);

  const stlObjects = uploadObjects.filter((o) => o.Key.toLowerCase().endsWith('.stl'));
  const metaKeys = new Set(
    metaObjects.map((o) => o.Key).filter((key) => key.endsWith('.json') && key.length > META_PREFIX.length + 5)
  );

  // Only fetch sidecars that actually exist for a live STL.
  const sidecars = new Map();
  const wanted = stlObjects.map((o) => metaKeyFor(o.Key)).filter((key) => metaKeys.has(key));
  await mapWithConcurrency(wanted, s3Concurrency, async (key) => {
    try {
      const record = await getJson(key);
      if (record) sidecars.set(key, record);
    } catch {
      // A damaged sidecar just falls back to inferred attribution.
    }
  });

  const files = stlObjects.map((object) => {
    const { originalName, uploadedAt } = parseUploadKey(object.Key);
    const usage = snapshot.usageByFileKey.get(object.Key) || null;
    const sidecar = sidecars.get(metaKeyFor(object.Key)) || null;

    let attribution;
    if (sidecar) attribution = 'uploaded-by';
    else if (usage && usage.jobIds.length > 0) attribution = 'first-simulated-by';
    else attribution = 'orphaned';

    return {
      fileKey: object.Key,
      originalName: sidecar?.originalName || originalName,
      size: object.Size || 0,
      // The key stamp and S3's own timestamp normally agree; a divergence means
      // the object was overwritten after it was first written.
      uploadedAt,
      lastModified: object.LastModified || null,
      attribution,
      uploader: sidecar ? { sub: sidecar.userSub || null, email: sidecar.userEmail || null } : null,
      usedBy: usage ? usage.users : [],
      runCount: usage ? usage.jobIds.length : 0,
      jobIds: usage ? usage.jobIds : [],
      firstUsedAt: usage ? usage.firstUsedAt : null,
      lastUsedAt: usage ? usage.lastUsedAt : null
    };
  });

  files.sort((a, b) => new Date(b.lastModified || 0) - new Date(a.lastModified || 0));

  // Jobs referencing geometry that is no longer in the bucket. Surfaced
  // separately so the two views reconcile instead of quietly disagreeing.
  const liveKeys = new Set(stlObjects.map((o) => o.Key));
  const missing = [];
  for (const [fileKey, usage] of snapshot.usageByFileKey) {
    if (fileKey.startsWith(UPLOAD_PREFIX) && !liveKeys.has(fileKey)) {
      missing.push({
        fileKey,
        originalName: parseUploadKey(fileKey).originalName,
        runCount: usage.jobIds.length,
        jobIds: usage.jobIds,
        usedBy: usage.users,
        lastUsedAt: usage.lastUsedAt
      });
    }
  }

  // Sidecars whose upload never completed — the user opened the file picker,
  // the backend signed a URL, and nothing was ever PUT.
  const stale = [...metaKeys]
    .filter((key) => !liveKeys.has(fileKeyForMeta(key)))
    .map((key) => ({ metaKey: key, fileKey: fileKeyForMeta(key) }));

  return { files, missing, stale };
}

module.exports = {
  UPLOAD_PREFIX,
  META_PREFIX,
  metaKeyFor,
  fileKeyForMeta,
  parseUploadKey,
  buildUploads
};
