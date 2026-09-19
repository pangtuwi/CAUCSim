const support = require('./test-support');
support.setEnv();

jest.mock('@aws-sdk/client-s3', () => require('./test-support').s3Mock());
jest.mock('@aws-sdk/s3-request-presigner', () => require('./test-support').presignerMock());
jest.mock('aws-jwt-verify', () => require('./test-support').jwtVerifyMock());
jest.mock('@aws-sdk/client-cognito-identity-provider', () => require('./test-support').cognitoMock());

const request = require('supertest');
const app = require('./app');
const { invalidate } = require('./lib/jobs');
const { deriveState } = require('./lib/users');

const AUTH = ['Authorization', 'Bearer admin-token'];
const get = (path) => request(app).get(path).set(...AUTH);

const byEmail = (body, email) => body.users.find((user) => user.email === email);

beforeEach(() => {
  support.reset();
  invalidate();
});

describe('deriveState', () => {
  it.each([
    [{ Enabled: true, UserStatus: 'CONFIRMED' }, 'active'],
    [{ Enabled: true, UserStatus: 'FORCE_CHANGE_PASSWORD' }, 'invited'],
    [{ Enabled: true, UserStatus: 'RESET_REQUIRED' }, 'reset-required'],
    [{ Enabled: false, UserStatus: 'CONFIRMED' }, 'disabled'],
    // Disabled wins over any status: it is the more consequential fact.
    [{ Enabled: false, UserStatus: 'FORCE_CHANGE_PASSWORD' }, 'disabled'],
    [{ Enabled: true, UserStatus: 'UNCONFIRMED' }, 'unconfirmed']
  ])('maps %j to %s', (user, expected) => {
    expect(deriveState(user)).toBe(expected);
  });
});

describe('GET /api/admin/users', () => {
  it('concatenates every page of ListUsers', async () => {
    // The mock pages two at a time, so five users means three pages.
    support.state.users = [
      support.makeCognitoUser({ sub: 'sub-1', email: 'one@example.com' }),
      support.makeCognitoUser({ sub: 'sub-2', email: 'two@example.com' }),
      support.makeCognitoUser({ sub: 'sub-3', email: 'three@example.com' }),
      support.makeCognitoUser({ sub: 'sub-4', email: 'four@example.com' }),
      support.makeCognitoUser({ sub: 'sub-5', email: 'five@example.com' })
    ];

    const res = await get('/api/admin/users');
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(5);
  });

  // Username here is a generated UUID because the pool signs in by email. The
  // attribute is what job.json.userSub is written from, so it is the join key.
  it('reads sub from the attributes, not from Username', async () => {
    support.state.users = [support.makeCognitoUser({ sub: 'real-sub', email: 'one@example.com', Username: 'uuid-unrelated' })];

    const res = await get('/api/admin/users');
    expect(byEmail(res.body, 'one@example.com').sub).toBe('real-sub');
    expect(byEmail(res.body, 'one@example.com').username).toBe('uuid-unrelated');
  });

  it('badges members of the admin group', async () => {
    support.state.users = [
      support.makeCognitoUser({ sub: 'sub-1', email: 'one@example.com', Username: 'uuid-1' }),
      support.makeCognitoUser({ sub: 'sub-2', email: 'two@example.com', Username: 'uuid-2' })
    ];
    support.state.adminUsernames = ['uuid-2'];

    const res = await get('/api/admin/users');
    expect(byEmail(res.body, 'one@example.com').isAdmin).toBe(false);
    expect(byEmail(res.body, 'two@example.com').isAdmin).toBe(true);
  });

  it('attaches simulation counts and the last run, matched on sub', async () => {
    support.state.users = [support.makeCognitoUser({ sub: 'user-sub-1', email: 'one@example.com' })];
    support.putJob(support.makeJob({
      jobId: 'job-1700000000001-aaaaaaaa', userSub: 'user-sub-1', status: 'completed', startedAt: '2026-01-01T10:00:00.000Z'
    }));
    support.putJob(support.makeJob({
      jobId: 'job-1700000000002-bbbbbbbb', userSub: 'user-sub-1', status: 'failed', startedAt: '2026-02-01T10:00:00.000Z'
    }));

    const user = byEmail((await get('/api/admin/users')).body, 'one@example.com');
    expect(user.simulationCount).toBe(2);
    expect(user.completedCount).toBe(1);
    expect(user.failedCount).toBe(1);
    expect(user.lastRunAt).toBe('2026-02-01T10:00:00.000Z');
    expect(user.lastRunJobId).toBe('job-1700000000002-bbbbbbbb');
  });

  // Jobs written before userSub existed still have an email.
  it('falls back to matching on email when a job has no userSub', async () => {
    support.state.users = [support.makeCognitoUser({ sub: 'user-sub-1', email: 'one@example.com' })];
    support.putJob(support.makeJob({
      jobId: 'job-1700000000001-aaaaaaaa', userSub: undefined, userEmail: 'One@Example.com'
    }));

    expect(byEmail((await get('/api/admin/users')).body, 'one@example.com').simulationCount).toBe(1);
  });

  it('counts a job once even when both sub and email match', async () => {
    support.state.users = [support.makeCognitoUser({ sub: 'user-sub-1', email: 'one@example.com' })];
    support.putJob(support.makeJob({
      jobId: 'job-1700000000001-aaaaaaaa', userSub: 'user-sub-1', userEmail: 'one@example.com'
    }));

    expect(byEmail((await get('/api/admin/users')).body, 'one@example.com').simulationCount).toBe(1);
  });

  // Otherwise a deleted account's simulations would be invisible here while
  // still showing on the simulations page.
  it('buckets jobs belonging to no current account into one synthetic row', async () => {
    support.state.users = [support.makeCognitoUser({ sub: 'user-sub-1', email: 'one@example.com' })];
    support.putJob(support.makeJob({
      jobId: 'job-1700000000001-aaaaaaaa', userSub: 'gone-sub', userEmail: 'gone@example.com'
    }));

    const res = await get('/api/admin/users');
    const synthetic = res.body.users.find((user) => user.synthetic);
    expect(synthetic).toBeDefined();
    expect(synthetic.simulationCount).toBe(1);
    expect(synthetic.state).toBe('unknown-account');
  });

  // Runs written before job.json carried userSub/userEmail are a different
  // case from a deleted account, and must not be described as one.
  it('separates jobs with no recorded user from jobs whose owner was deleted', async () => {
    support.state.users = [support.makeCognitoUser({ sub: 'user-sub-1', email: 'one@example.com' })];
    support.putJob(support.makeJob({
      jobId: 'job-1700000000001-aaaaaaaa', userSub: 'gone-sub', userEmail: 'gone@example.com'
    }));
    const legacy = support.makeJob({ jobId: 'job-1700000000002-bbbbbbbb' });
    delete legacy.userSub;
    delete legacy.userEmail;
    support.putJob(legacy);
    const legacy2 = support.makeJob({ jobId: 'job-1700000000003-cccccccc' });
    delete legacy2.userSub;
    delete legacy2.userEmail;
    support.putJob(legacy2);

    const res = await get('/api/admin/users');
    const deleted = res.body.users.find((user) => user.state === 'unknown-account');
    const noUser = res.body.users.find((user) => user.state === 'no-user');
    expect(deleted.simulationCount).toBe(1);
    expect(noUser.simulationCount).toBe(2);
    expect(noUser.synthetic).toBe(true);
    // Every job on the simulations page is accounted for on this one.
    const total = res.body.users.reduce((sum, user) => sum + user.simulationCount, 0);
    expect(total).toBe(3);
  });

  it('counts only enabled+confirmed accounts as active', async () => {
    support.state.users = [
      support.makeCognitoUser({ sub: 'sub-1', email: 'one@example.com' }),
      support.makeCognitoUser({ sub: 'sub-2', email: 'two@example.com', Enabled: false }),
      support.makeCognitoUser({ sub: 'sub-3', email: 'three@example.com', UserStatus: 'FORCE_CHANGE_PASSWORD' })
    ];

    const res = await get('/api/admin/users');
    expect(res.body.total).toBe(3);
    expect(res.body.activeCount).toBe(1);
  });

  it('explains a missing Cognito permission rather than 500ing', async () => {
    const err = new Error('User is not authorized to perform cognito-idp:ListUsers');
    err.name = 'AccessDeniedException';
    support.state.cognitoError = err;

    const res = await get('/api/admin/users');
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('cognito-permissions');
    expect(res.body.error).toContain('ListUsers');
  });

  it('explains a missing admin group', async () => {
    const err = new Error('Group not found');
    err.name = 'ResourceNotFoundException';
    support.state.cognitoError = err;

    const res = await get('/api/admin/users');
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('group-missing');
  });

  it('is not reachable without the admin group', async () => {
    const res = await request(app).get('/api/admin/users').set('Authorization', 'Bearer user-token');
    expect(res.status).toBe(403);
  });
});
