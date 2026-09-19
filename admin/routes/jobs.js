const express = require('express');

const {
  assertJobId,
  getText,
  deleteByPrefix,
  presignDownload,
  sanitiseFilename,
  badRequest
} = require('../lib/s3');
const { scanJobs, invalidate, isInFlight, JOB_PREFIX } = require('../lib/jobs');
const { audit } = require('../lib/audit');

const router = express.Router();

// A filename stem for downloads, derived from the model the run was based on.
// Mirrors downloadStem() in backend/app/app.js.
function downloadStem(job) {
  return sanitiseFilename(String(job.originalName || 'model').replace(/\.[^.]*$/, '')).slice(0, 60) || 'model';
}

function matchesFilters(job, query) {
  const { user, status, q, from, to } = query;

  if (user && job.userSub !== user && (job.userEmail || '').toLowerCase() !== String(user).toLowerCase()) {
    return false;
  }
  if (status && job.status !== status) return false;
  if (from && (!job.startedAt || job.startedAt < from)) return false;
  if (to && (!job.startedAt || job.startedAt > to)) return false;

  if (q) {
    const needle = String(q).toLowerCase();
    const haystack = [job.runName, job.originalName, job.jobId, job.userEmail, job.purpose]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

const SORTERS = {
  started: (a, b) => new Date(a.startedAt || 0) - new Date(b.startedAt || 0),
  updated: (a, b) => new Date(a.updatedAt || 0) - new Date(b.updatedAt || 0),
  user: (a, b) => String(a.userEmail || '').localeCompare(String(b.userEmail || '')),
  status: (a, b) => String(a.status || '').localeCompare(String(b.status || '')),
  size: (a, b) => (a.totalBytes || 0) - (b.totalBytes || 0)
};

// GET /api/admin/jobs — every job, from every user. That is the whole point of
// this app: the CFD app's /api/jobs filters to the caller's own userSub.
router.get('/jobs', async (req, res, next) => {
  try {
    const snapshot = await scanJobs({ refresh: req.query.refresh === '1' });

    const filtered = snapshot.jobs.filter((job) => matchesFilters(job, req.query));
    const sorter = SORTERS[req.query.sort] || SORTERS.started;
    const direction = req.query.order === 'asc' ? 1 : -1;
    const jobs = [...filtered].sort((a, b) => sorter(a, b) * direction);

    res.json({
      jobs,
      total: snapshot.jobs.length,
      shown: jobs.length,
      malformed: snapshot.malformed,
      scannedAt: snapshot.scannedAt
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/jobs/:jobId — one job plus the contents of its prefix.
router.get('/jobs/:jobId', async (req, res, next) => {
  try {
    const jobId = assertJobId(req.params.jobId);
    const snapshot = await scanJobs();
    const job = snapshot.byJobId.get(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    res.json({
      job,
      artifacts: snapshot.artifactsByJobId.get(jobId) || [],
      usage: snapshot.usageByFileKey.get(job.fileKey) || null
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/jobs/:jobId/job.json
//
// Served directly from the already-stripped in-memory object, NOT presigned.
// A presigned URL serves the raw S3 object, which still contains jobToken —
// this is the one artifact where handing out a signed URL would leak the
// droplet callback secret.
router.get('/jobs/:jobId/job.json', async (req, res, next) => {
  try {
    const jobId = assertJobId(req.params.jobId);
    const snapshot = await scanJobs();
    const job = snapshot.byJobId.get(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadStem(job)}-${jobId}-job.json"`);
    res.send(JSON.stringify(job, null, 2));
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/jobs/:jobId/log
router.get('/jobs/:jobId/log', async (req, res, next) => {
  try {
    const jobId = assertJobId(req.params.jobId);
    const log = await getText(`${JOB_PREFIX}${jobId}/simulation.log`);
    if (log === null) return res.status(404).json({ error: 'No simulation.log for this job' });

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(log);
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/jobs/:jobId/download?file=results.zip
//
// Returns { url } rather than redirecting: a 302 straight to S3 turns a missing
// object into an XML error page rendered over the admin UI, where a JSON error
// can be shown as a toast.
router.get('/jobs/:jobId/download', async (req, res, next) => {
  try {
    const jobId = assertJobId(req.params.jobId);
    const file = req.query.file || 'results.zip';
    if (typeof file !== 'string' || file.includes('/') || file.includes('..')) {
      throw badRequest('Invalid file name');
    }

    const snapshot = await scanJobs();
    const job = snapshot.byJobId.get(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (file === 'job.json') {
      throw badRequest('Use /jobs/:jobId/job.json — job.json is never presigned');
    }

    // Validate against what is actually in the prefix rather than a hardcoded
    // allowlist, so new artifact types work without a code change.
    const artifacts = snapshot.artifactsByJobId.get(jobId) || [];
    const artifact = artifacts.find((a) => a.name === file);
    if (!artifact) return res.status(404).json({ error: `No "${file}" for this job` });

    const url = await presignDownload(artifact.key, `${downloadStem(job)}-${jobId}-${file}`);
    audit('presign-download', req.admin, { target: artifact.key, details: { jobId, file }, req });
    res.json({ url, filename: file, size: artifact.size });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/jobs/:jobId  body: { confirm: "<jobId>" }
router.delete('/jobs/:jobId', async (req, res, next) => {
  try {
    const jobId = assertJobId(req.params.jobId);
    const snapshot = await scanJobs();
    const job = snapshot.byJobId.get(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    // Refuse in-flight runs outright, with no force override.
    //
    // The droplet writes job.json and simulation.log into this prefix itself,
    // on a loop, so deleting mid-run just means it reappears half-formed. Worse,
    // deleting the record does not stop the droplet — it keeps billing at
    // gd-16vcpu-64gb with nothing left pointing at it. Stop the run first.
    if (isInFlight(job.status)) {
      audit('delete-job', req.admin, {
        target: jobId,
        outcome: 'refused',
        details: { reason: 'job-in-flight', status: job.status, dropletId: job.dropletId || null },
        req
      });
      const droplet = job.dropletId ? `droplet ${job.dropletId}` : 'its droplet';
      return res.status(409).json({
        error: `This run is ${job.status} on ${droplet}. Stop it in the CFD app before deleting it, or the droplet keeps running and rewrites these files.`,
        code: 'job-in-flight',
        reason: 'job-in-flight',
        status: job.status,
        dropletId: job.dropletId || null
      });
    }

    // Re-check the typed confirmation server-side. The client check is UX; this
    // is the control.
    if (req.body?.confirm !== jobId) {
      audit('delete-job', req.admin, { target: jobId, outcome: 'refused', details: { reason: 'confirm-mismatch' }, req });
      return res.status(400).json({ error: 'Confirmation did not match the job id', code: 'confirm-mismatch' });
    }

    const result = await deleteByPrefix(`${JOB_PREFIX}${jobId}/`);
    invalidate();

    audit('delete-job', req.admin, {
      target: jobId,
      outcome: result.errors.length > 0 ? 'error' : 'success',
      details: {
        keysDeleted: result.deleted,
        bytes: result.bytes,
        errors: result.errors.length,
        runName: job.runName,
        userEmail: job.userEmail
      },
      req
    });

    if (result.errors.length > 0) {
      return res.status(500).json({
        error: `Deleted ${result.deleted} of ${result.keys.length} objects; ${result.errors.length} failed.`,
        deleted: result.deleted,
        errors: result.errors
      });
    }

    res.json({ deleted: result.deleted, bytes: result.bytes, errors: [] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
