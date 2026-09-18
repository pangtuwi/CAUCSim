// S3 access for the admin app.
//
// The important difference from backend/app/app.js is that every listing here
// paginates. A bare ListObjectsV2Command returns at most 1000 keys and says so
// only via IsTruncated, so code that ignores it silently stops seeing data —
// which at roughly 11 keys per completed job is somewhere around job 90.
const path = require('path');
const {
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const { bucketName } = require('./config');
const { s3Client } = require('./aws');

// S3 accepts at most 1000 keys per DeleteObjects call.
const DELETE_BATCH_SIZE = 1000;

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

const badRequest = (message) => new HttpError(400, message);

/** List every object under `prefix`, following continuation tokens. */
async function listAllObjects(prefix) {
  const objects = [];
  let continuationToken;

  do {
    const page = await s3Client.send(new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix,
      ContinuationToken: continuationToken
    }));
    for (const item of page.Contents || []) {
      objects.push({ Key: item.Key, Size: item.Size, LastModified: item.LastModified });
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  return objects;
}

/** Fetch and JSON.parse an object. Returns null when the key does not exist. */
async function getJson(key) {
  try {
    const response = await s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
    return JSON.parse(await response.Body.transformToString());
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.code === 'NoSuchKey') return null;
    throw err;
  }
}

/** Fetch an object as text. Returns null when the key does not exist. */
async function getText(key) {
  try {
    const response = await s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
    return await response.Body.transformToString();
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.code === 'NoSuchKey') return null;
    throw err;
  }
}

/**
 * Delete every object under `prefix`.
 *
 * DeleteObjects returns HTTP 200 even when individual keys failed — the
 * failures come back in an Errors array. Ignoring it produces a cheerful
 * "deleted!" over a half-deleted prefix, so collect and return them.
 */
async function deleteByPrefix(prefix) {
  const objects = await listAllObjects(prefix);
  const keys = objects.map((o) => o.Key);
  const bytes = objects.reduce((total, o) => total + (o.Size || 0), 0);
  const errors = [];
  let deleted = 0;

  for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
    const batch = keys.slice(i, i + DELETE_BATCH_SIZE);
    const response = await s3Client.send(new DeleteObjectsCommand({
      Bucket: bucketName,
      Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: false }
    }));
    deleted += (response.Deleted || []).length;
    for (const error of response.Errors || []) {
      errors.push({ key: error.Key, code: error.Code, message: error.Message });
    }
  }

  return { deleted, errors, keys, bytes };
}

/** Delete a single object. Missing keys are not an error in S3, nor here. */
async function deleteObject(key) {
  await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
}

/**
 * Presign a GET that downloads rather than displays.
 * Short expiry: these are handed to a browser that follows them immediately.
 */
async function presignDownload(key, filename, { expiresIn = 300 } = {}) {
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${sanitiseFilename(filename)}"`
  });
  return getSignedUrl(s3Client, command, { expiresIn });
}

/** Reduce a name to something safe to put in a Content-Disposition header. */
function sanitiseFilename(name) {
  return String(name || 'download')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 120) || 'download';
}

/**
 * Validate a client-supplied key and return its normalised form.
 * Modelled on the check in backend/app/app.js: reject traversal, then require
 * the key to sit strictly inside the expected prefix.
 */
function assertKey(key, prefix) {
  if (!key || typeof key !== 'string') throw badRequest('A key is required');
  if (key.includes('..') || key.includes('\0')) throw badRequest('Invalid key');

  const normalised = path.posix.normalize(key);
  if (!normalised.startsWith(prefix) || normalised === prefix) {
    throw badRequest(`Invalid key: must be inside "${prefix}"`);
  }
  return normalised;
}

const assertUploadKey = (key) => assertKey(key, 'uploads/');

// Job routes take an id and *construct* the prefix themselves — a caller must
// never be able to hand a raw `results/...` prefix to deleteByPrefix, which
// would make "delete the entire results tree" a single crafted request.
const JOB_ID_PATTERN = /^job-\d{10,16}-[0-9a-f]{8}$/;

function assertJobId(jobId) {
  if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw badRequest('Invalid job id');
  }
  return jobId;
}

module.exports = {
  HttpError,
  badRequest,
  listAllObjects,
  getJson,
  getText,
  deleteByPrefix,
  deleteObject,
  presignDownload,
  sanitiseFilename,
  assertKey,
  assertUploadKey,
  assertJobId,
  DELETE_BATCH_SIZE
};
