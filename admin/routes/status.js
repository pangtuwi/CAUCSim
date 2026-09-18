const express = require('express');

const { region, clientId, adminGroup, bucketName } = require('../lib/config');
const { requireAdmin } = require('../lib/auth');

const router = express.Router();

// Public — the sign-in page needs the Cognito client id and region before
// anyone can authenticate, exactly as the CFD app's /api/status does.
//
// Unlike that endpoint, this one does NOT return the bucket name. There is no
// reason for an anonymous caller to learn it; bucket details sit behind /me.
router.get('/status', (req, res) => {
  res.json({
    status: 'online',
    app: 'caucsim-admin',
    cognito: { clientId, region },
    adminGroup
  });
});

// Authenticated identity probe. The frontend calls this straight after sign-in
// so a non-admin gets the "not an admin" screen immediately, rather than seeing
// the shell and then watching every data view fail.
router.get('/me', requireAdmin, (req, res) => {
  res.json({
    sub: req.admin.sub,
    email: req.admin.email,
    groups: req.admin.groups,
    bucketName,
    region
  });
});

module.exports = router;
