const express = require('express');

const { listAllUsers, listAdminUsernames, shapeUser, enrichWithJobs } = require('../lib/users');
const { scanJobs } = require('../lib/jobs');
const { adminGroup } = require('../lib/config');

const router = express.Router();

// GET /api/admin/users
//
// Every account in the pool, not just the active ones — a disabled or
// never-signed-in account still owns data, and hiding it here would make the
// counts disagree with the simulations view. Filtering is the UI's job.
router.get('/users', async (req, res, next) => {
  try {
    const snapshot = await scanJobs({ refresh: req.query.refresh === '1' });

    let rawUsers;
    let adminUsernames;
    try {
      [rawUsers, adminUsernames] = await Promise.all([listAllUsers(), listAdminUsernames()]);
    } catch (err) {
      // The rest of the app works without Cognito read permission, so degrade
      // this one view rather than failing the request outright.
      if (err.name === 'AccessDeniedException' || err.name === 'NotAuthorizedException') {
        return res.status(502).json({
          error: 'Cognito read permissions are missing. This app needs cognito-idp:ListUsers and ListUsersInGroup on the user pool.',
          code: 'cognito-permissions'
        });
      }
      // The group simply not existing yet is the single most likely first-run
      // failure, and it has a one-command fix.
      if (err.name === 'ResourceNotFoundException') {
        return res.status(502).json({
          error: `The Cognito group "${adminGroup}" does not exist. Create it with: aws cognito-idp create-group --group-name ${adminGroup} …`,
          code: 'group-missing'
        });
      }
      throw err;
    }

    const users = enrichWithJobs(
      rawUsers.map((user) => shapeUser(user, adminUsernames)),
      snapshot
    );

    users.sort((a, b) => String(a.email || '').localeCompare(String(b.email || '')));

    res.json({
      users,
      total: users.length,
      activeCount: users.filter((u) => u.state === 'active').length,
      adminGroup,
      scannedAt: snapshot.scannedAt
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
