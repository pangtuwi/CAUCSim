// Audit trail for administrative actions.
//
// Every record goes to stdout as a single JSON line: the terminal locally,
// CloudWatch under Lambda. CloudWatch is the durable sink and is searchable,
// so it is the primary record. ADMIN_AUDIT_S3=true additionally writes one
// object per action into the bucket (S3 cannot append, hence one object each).
//
// Read-only list calls are deliberately NOT audited — they would drown the
// signal. What is audited: every destructive action *including its refusals*
// (a mistyped confirmation is itself worth seeing), every presigned URL handed
// out, and every 403 (someone with a valid CAUCSim account probing the admin
// app).
const crypto = require('crypto');
const { PutObjectCommand } = require('@aws-sdk/client-s3');

const { bucketName, auditToS3 } = require('./config');
const { s3Client } = require('./aws');

/**
 * @param {string} action     e.g. 'delete-job', 'delete-upload', 'presign-download', 'access-denied'
 * @param {object} actor      { sub, email } of the signed-in admin, or the rejected caller
 * @param {object} [options]
 * @param {string} [options.target]   what was acted on (jobId, fileKey, …)
 * @param {string} [options.outcome]  'success' | 'refused' | 'error'
 * @param {object} [options.details]  action-specific extras
 * @param {object} [options.req]      Express request, for ip / user-agent
 */
function audit(action, actor, options = {}) {
  const { target = null, outcome = 'success', details = {}, req = null } = options;

  const record = {
    type: 'admin-audit',
    at: new Date().toISOString(),
    action,
    actor: { sub: actor?.sub || null, email: actor?.email || null },
    target,
    outcome,
    details,
    ip: req ? req.ip : null,
    userAgent: req ? req.get('user-agent') || null : null
  };

  console.log(JSON.stringify(record));

  if (!auditToS3) return;

  // Fire-and-forget: an audit write must never fail the action it describes,
  // and the console line above has already recorded it.
  const day = record.at.slice(0, 10);
  const key = `admin-audit/${day}/${record.at.replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}.json`;
  s3Client
    .send(new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: JSON.stringify(record, null, 2),
      ContentType: 'application/json'
    }))
    .catch((err) => console.error('Audit: failed to write audit object to S3:', err.message));
}

module.exports = { audit };
