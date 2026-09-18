// Configuration for the admin app.
//
// The admin app deliberately shares the CFD app's AWS credentials, bucket and
// Cognito pool: it is a second view onto exactly the same data, not a second
// deployment. Shared values therefore come from the repo-root .env, and only
// admin-specific knobs live in admin/.env.
//
// LOAD ORDER MATTERS. dotenv never overwrites a variable that is already set,
// so the *more specific* file has to be loaded first or its overrides are
// silently ignored. admin/.env first, repo-root .env second.
const path = require('path');

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });
}

const REQUIRED = ['S3_BUCKET_NAME', 'COGNITO_USER_POOL_ID', 'COGNITO_CLIENT_ID'];

const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) {
  throw new Error(
    `FATAL ERROR: missing required environment variable(s): ${missing.join(', ')}.\n` +
    `Looked in ${path.join(__dirname, '..', '.env')} and ${path.join(__dirname, '..', '..', '.env')}.\n` +
    `Copy admin/.env.example to admin/.env, and see Documentation/AWSCONFIG.md for the live values.`
  );
}

// Positive integer or the fallback — guards against an env var set to "", "0"
// or a typo silently disabling concurrency / caching.
const intFromEnv = (name, fallback) => {
  const parsed = Number.parseInt(process.env[name], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

module.exports = {
  bucketName: process.env.S3_BUCKET_NAME,
  region: process.env.AWS_REGION || 'eu-west-2',
  userPoolId: process.env.COGNITO_USER_POOL_ID,
  clientId: process.env.COGNITO_CLIENT_ID,
  adminGroup: process.env.ADMIN_GROUP || 'admins',
  port: intFromEnv('ADMIN_PORT', 3001),
  s3Concurrency: intFromEnv('ADMIN_S3_CONCURRENCY', 8),
  jobCacheTtlMs: intFromEnv('ADMIN_JOB_CACHE_TTL_MS', 30000),
  auditToS3: process.env.ADMIN_AUDIT_S3 === 'true'
};
