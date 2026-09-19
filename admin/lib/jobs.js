// The shared scan of the results/ prefix.
//
// Users, simulations and uploads all need the same thing: every job.json in the
// bucket. Scanning is one LIST plus one GET per job, so it is done once and
// cached briefly, and all three views are served from the same snapshot.
const { listAllObjects, getJson } = require('./s3');
const { mapWithConcurrency } = require('./concurrency');
const { s3Concurrency, jobCacheTtlMs } = require('./config');

const JOB_PREFIX = 'results/';
const IN_FLIGHT_STATUSES = new Set(['queued', 'running']);

let cache = null;        // { scannedAt: number, data: {...} }
let inFlight = null;     // de-duplicates concurrent cold scans

/**
 * Remove the droplet callback secret.
 *
 * Done once, here, before anything is cached or returned — never per route.
 * The CFD backend strips it in four separate places, which is exactly how the
 * fifth route ends up leaking it.
 */
function stripToken(job) {
  const safe = { ...job };
  delete safe.jobToken;
  return safe;
}

function jobIdFromKey(key) {
  // 'results/<jobId>/job.json' -> '<jobId>'.
  // Returns null for anything sitting directly under results/ with no job
  // directory of its own, so a stray object cannot invent a job id.
  const separator = key.indexOf('/', JOB_PREFIX.length);
  return separator === -1 ? null : key.slice(JOB_PREFIX.length, separator);
}

async function performScan() {
  const objects = await listAllObjects(JOB_PREFIX);

  const jobKeys = [];
  const artifactsByJobId = new Map();

  for (const object of objects) {
    const jobId = jobIdFromKey(object.Key);
    if (!jobId) continue;

    if (object.Key.endsWith('/job.json')) {
      jobKeys.push(object.Key);
    }

    // Keep every key, job.json included, so the detail view can list the whole
    // prefix with its sizes without a second round trip.
    if (!artifactsByJobId.has(jobId)) artifactsByJobId.set(jobId, []);
    artifactsByJobId.get(jobId).push({
      name: object.Key.slice(JOB_PREFIX.length + jobId.length + 1),
      key: object.Key,
      size: object.Size || 0,
      lastModified: object.LastModified || null
    });
  }

  const malformed = [];
  const parsed = await mapWithConcurrency(jobKeys, s3Concurrency, async (key) => {
    try {
      const job = await getJson(key);
      if (!job || typeof job !== 'object') {
        malformed.push({ key, error: 'job.json is empty or not an object' });
        return null;
      }
      return stripToken(job);
    } catch (err) {
      // One bad job.json must not take the whole listing down with it — the
      // admin app is most useful precisely when something is wrong.
      malformed.push({ key, error: err.message });
      return null;
    }
  });

  const jobs = parsed.filter(Boolean);
  jobs.sort((a, b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0));

  const byJobId = new Map();
  const bySub = new Map();
  const byEmail = new Map();
  const usageByFileKey = new Map();

  for (const job of jobs) {
    const artifacts = artifactsByJobId.get(job.jobId) || [];
    job.artifactCount = artifacts.length;
    job.totalBytes = artifacts.reduce((total, a) => total + a.size, 0);

    byJobId.set(job.jobId, job);

    if (job.userSub) {
      if (!bySub.has(job.userSub)) bySub.set(job.userSub, []);
      bySub.get(job.userSub).push(job);
    }
    if (job.userEmail) {
      const email = job.userEmail.toLowerCase();
      if (!byEmail.has(email)) byEmail.set(email, []);
      byEmail.get(email).push(job);
    }

    if (job.fileKey) {
      if (!usageByFileKey.has(job.fileKey)) {
        usageByFileKey.set(job.fileKey, { jobIds: [], users: [], firstUsedAt: null, lastUsedAt: null });
      }
      const usage = usageByFileKey.get(job.fileKey);
      usage.jobIds.push(job.jobId);
      if (job.userEmail && !usage.users.some((u) => u.email === job.userEmail)) {
        usage.users.push({ sub: job.userSub || null, email: job.userEmail });
      }
      const startedAt = job.startedAt || null;
      if (startedAt) {
        if (!usage.firstUsedAt || startedAt < usage.firstUsedAt) usage.firstUsedAt = startedAt;
        if (!usage.lastUsedAt || startedAt > usage.lastUsedAt) usage.lastUsedAt = startedAt;
      }
    }
  }

  return {
    jobs,
    byJobId,
    bySub,
    byEmail,
    artifactsByJobId,
    usageByFileKey,
    malformed,
    scannedAt: new Date().toISOString()
  };
}

/**
 * Return the current snapshot, scanning if the cached one has expired.
 * @param {{ refresh?: boolean }} [options]
 */
async function scanJobs({ refresh = false } = {}) {
  const fresh = cache && Date.now() - cache.scannedAt < jobCacheTtlMs;
  if (!refresh && fresh) return cache.data;

  // Collapse a burst of simultaneous cold requests into one scan.
  if (inFlight) return inFlight;

  inFlight = performScan()
    .then((data) => {
      cache = { scannedAt: Date.now(), data };
      return data;
    })
    .finally(() => { inFlight = null; });

  return inFlight;
}

/** Drop the cached snapshot. Called after every successful delete. */
function invalidate() {
  cache = null;
}

const isInFlight = (status) => IN_FLIGHT_STATUSES.has(status);

module.exports = { scanJobs, invalidate, stripToken, isInFlight, JOB_PREFIX };
