// Cognito user listing.
//
// A caveat that shapes this whole module: Cognito does not record when someone
// last signed in. UserLastModifiedDate moves on password changes and attribute
// edits, not on authentication, so it must never be presented as a login time.
// The only genuine activity signal available is job.json, so "last active" here
// means "last simulation run".
const {
  ListUsersCommand,
  ListUsersInGroupCommand
} = require('@aws-sdk/client-cognito-identity-provider');

const { cognitoClient } = require('./aws');
const { userPoolId, adminGroup } = require('./config');

// ListUsers caps Limit at 60, so the pagination loop is mandatory rather than
// an optimisation. The page cap stops a pagination bug spinning forever.
const PAGE_SIZE = 60;
const MAX_PAGES = 50;

function attributesToMap(attributes = []) {
  const map = {};
  for (const { Name, Value } of attributes) map[Name] = Value;
  return map;
}

/**
 * Collapse Cognito's Enabled boolean and UserStatus string into one state, so
 * the UI can show a single pill instead of two fields that need cross-reading.
 */
function deriveState(user) {
  if (user.Enabled === false) return 'disabled';
  switch (user.UserStatus) {
    case 'CONFIRMED': return 'active';
    // Invited but never signed in — where admin-create-user leaves an account.
    case 'FORCE_CHANGE_PASSWORD': return 'invited';
    case 'RESET_REQUIRED': return 'reset-required';
    default: return (user.UserStatus || 'unknown').toLowerCase();
  }
}

async function listAllUsers() {
  const users = [];
  let paginationToken;
  let pages = 0;

  do {
    const page = await cognitoClient.send(new ListUsersCommand({
      UserPoolId: userPoolId,
      Limit: PAGE_SIZE,
      PaginationToken: paginationToken
    }));
    users.push(...(page.Users || []));
    paginationToken = page.PaginationToken;
  } while (paginationToken && ++pages < MAX_PAGES);

  return users;
}

/** The set of Usernames in the admin group — one call, not one per user. */
async function listAdminUsernames() {
  const usernames = new Set();
  let nextToken;
  let pages = 0;

  do {
    const page = await cognitoClient.send(new ListUsersInGroupCommand({
      UserPoolId: userPoolId,
      GroupName: adminGroup,
      Limit: PAGE_SIZE,
      NextToken: nextToken
    }));
    for (const user of page.Users || []) usernames.add(user.Username);
    nextToken = page.NextToken;
  } while (nextToken && ++pages < MAX_PAGES);

  return usernames;
}

/**
 * Shape one Cognito user for the UI.
 *
 * `sub` is read out of the Attributes array rather than taken from Username.
 * In this pool they happen to coincide (email sign-in means Cognito generates a
 * UUID username), but sub is the attribute that job.json.userSub is written
 * from, so it is the correct join key and the only one guaranteed to match.
 */
function shapeUser(user, adminUsernames) {
  const attributes = attributesToMap(user.Attributes);
  return {
    sub: attributes.sub || null,
    email: attributes.email || user.Username,
    emailVerified: attributes.email_verified === 'true',
    username: user.Username,
    enabled: user.Enabled !== false,
    status: user.UserStatus || null,
    state: deriveState(user),
    isAdmin: adminUsernames.has(user.Username),
    createdAt: user.UserCreateDate || null,
    modifiedAt: user.UserLastModifiedDate || null
  };
}

/**
 * Attach simulation activity from an existing job scan. No extra S3 traffic —
 * the snapshot is the one the simulations view already built.
 *
 * Match on sub first and fall back to email, so a job written before userSub
 * existed still counts towards its owner.
 */
function enrichWithJobs(users, snapshot) {
  const claimedJobIds = new Set();

  const enriched = users.map((user) => {
    const bySub = user.sub ? snapshot.bySub.get(user.sub) : null;
    const byEmail = user.email ? snapshot.byEmail.get(user.email.toLowerCase()) : null;

    const jobs = [];
    for (const job of [...(bySub || []), ...(byEmail || [])]) {
      if (claimedJobIds.has(job.jobId)) continue;
      claimedJobIds.add(job.jobId);
      jobs.push(job);
    }

    return { ...user, ...summariseJobs(jobs) };
  });

  // Jobs belonging to nobody in the pool (the account was deleted) would
  // otherwise be invisible on this page. Surface them as one synthetic row so
  // the counts here reconcile with the simulations view.
  const orphanJobs = snapshot.jobs.filter((job) => !claimedJobIds.has(job.jobId));
  if (orphanJobs.length > 0) {
    enriched.push({
      sub: null,
      email: 'Deleted / unknown user',
      emailVerified: false,
      username: null,
      enabled: false,
      status: null,
      state: 'unknown-account',
      isAdmin: false,
      createdAt: null,
      modifiedAt: null,
      synthetic: true,
      ...summariseJobs(orphanJobs)
    });
  }

  return enriched;
}

function summariseJobs(jobs) {
  let lastRunAt = null;
  let lastRunJobId = null;
  let completedCount = 0;
  let failedCount = 0;
  let runningCount = 0;

  for (const job of jobs) {
    if (job.status === 'completed') completedCount++;
    else if (job.status === 'failed') failedCount++;
    else if (job.status === 'running' || job.status === 'queued') runningCount++;

    if (job.startedAt && (!lastRunAt || job.startedAt > lastRunAt)) {
      lastRunAt = job.startedAt;
      lastRunJobId = job.jobId;
    }
  }

  return {
    simulationCount: jobs.length,
    completedCount,
    failedCount,
    runningCount,
    lastRunAt,
    lastRunJobId
  };
}

module.exports = { listAllUsers, listAdminUsernames, shapeUser, enrichWithJobs, deriveState };
