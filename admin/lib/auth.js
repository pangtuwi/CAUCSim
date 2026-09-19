// Admin authentication: a verified Cognito ID token whose `cognito:groups`
// claim contains the admin group.
const { CognitoJwtVerifier } = require('aws-jwt-verify');

const { userPoolId, clientId, adminGroup } = require('./config');
const { audit } = require('./audit');

// Same construction as the CFD backend (backend/app/app.js). Note the absence
// of the `groups` option: aws-jwt-verify can check group membership during
// verification, but it then throws the same error for "wrong group" as it does
// for a bad signature or an expired token. This app needs those two outcomes to
// be distinguishable — 401 means "your token is stale, sign in again", 403 means
// "your account is fine but you are not an admin". Collapsed into one, a
// non-admin who keeps authenticating successfully loops on the sign-in screen
// forever. So verify here, check the group below.
const verifier = CognitoJwtVerifier.create({
  userPoolId,
  tokenUse: 'id',
  clientId
});

// The claim is normally an array, but tolerate a space/comma separated string
// so an unexpected claim shape degrades to "not an admin" rather than a crash.
function groupsFromPayload(payload) {
  const raw = payload['cognito:groups'];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') return raw.split(/[\s,]+/).filter(Boolean);
  return [];
}

const requireAdmin = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  let payload;
  try {
    payload = await verifier.verify(header.slice('Bearer '.length));
  } catch (err) {
    if (err.message && err.message.includes('expired')) {
      console.log(`Admin JWT: token expired (${err.message})`);
    } else {
      console.error('Admin JWT verification failed:', err.message);
    }
    return res.status(401).json({ error: 'Unauthorized: invalid or expired token', code: 'invalid-token' });
  }

  const groups = groupsFromPayload(payload);
  if (!groups.includes(adminGroup)) {
    audit('access-denied', { sub: payload.sub, email: payload.email }, {
      outcome: 'refused',
      details: { requiredGroup: adminGroup, groups },
      req
    });
    return res.status(403).json({
      error: `Forbidden: this account is not a member of the "${adminGroup}" group.`,
      code: 'not-admin'
    });
  }

  req.admin = { sub: payload.sub, email: payload.email, groups };
  next();
};

module.exports = { requireAdmin, groupsFromPayload };
