// CAUCSim Admin — users, simulations and CAD uploads across every account.
//
// Runs locally against real AWS (`npm start`, port 3001) and exports a
// serverless-http handler so it can be deployed as its own Lambda later. It is
// a separate app from backend/app/app.js on purpose: different audience,
// different IAM, and nothing here should ever be reachable from the CFD UI.
const path = require('path');
const express = require('express');
const serverless = require('serverless-http');

const config = require('./lib/config');
const { requireAdmin } = require('./lib/auth');
const { HttpError } = require('./lib/s3');

const statusRoutes = require('./routes/status');
const usersRoutes = require('./routes/users');
const jobsRoutes = require('./routes/jobs');
const uploadsRoutes = require('./routes/uploads');

const app = express();

app.use(express.json());
app.disable('x-powered-by');

// Admin data is never cacheable — a stale list is worse than a slow one when
// you are about to delete something from it.
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    }
  }
}));

// /status is public (the sign-in page needs the Cognito client id) and /me
// carries requireAdmin itself, so this router is mounted before the blanket
// guard below.
app.use('/api/admin', statusRoutes);

// Everything from here down needs a verified ID token carrying the admin group.
// Guarding the mount point rather than each route means a new route is
// protected by default instead of by remembering to add middleware.
app.use('/api/admin', requireAdmin);

app.use('/api/admin', usersRoutes);
app.use('/api/admin', jobsRoutes);
app.use('/api/admin', uploadsRoutes);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
app.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error('Unhandled admin error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) {
  // Loopback only. This app can delete anything in the bucket; it has no
  // business being reachable from the rest of the network.
  app.listen(config.port, '127.0.0.1', () => {
    console.log(`CAUCSim Admin listening on http://localhost:${config.port}`);
    console.log(`  bucket      ${config.bucketName}`);
    console.log(`  user pool   ${config.userPoolId} (${config.region})`);
    console.log(`  admin group ${config.adminGroup}`);
  });
}

module.exports = app;
module.exports.handler = serverless(app);
