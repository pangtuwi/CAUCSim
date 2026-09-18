const support = require('./test-support');
support.setEnv();

jest.mock('@aws-sdk/client-s3', () => require('./test-support').s3Mock());
jest.mock('@aws-sdk/s3-request-presigner', () => require('./test-support').presignerMock());
jest.mock('aws-jwt-verify', () => require('./test-support').jwtVerifyMock());
jest.mock('@aws-sdk/client-cognito-identity-provider', () => require('./test-support').cognitoMock());

const request = require('supertest');
const app = require('./app');
const { invalidate } = require('./lib/jobs');

beforeEach(() => {
  support.reset();
  invalidate();
});

describe('GET /api/admin/status (public)', () => {
  it('is reachable without a token', async () => {
    const res = await request(app).get('/api/admin/status');
    expect(res.status).toBe(200);
    expect(res.body.cognito).toEqual({ clientId: 'mockclient', region: 'eu-west-2' });
    expect(res.body.adminGroup).toBe('admins');
  });

  // The CFD app's /api/status hands the bucket name to anonymous callers.
  // Deliberately not repeated here.
  it('does not leak the bucket name', async () => {
    const res = await request(app).get('/api/admin/status');
    expect(JSON.stringify(res.body)).not.toContain('mock-bucket');
  });
});

describe('requireAdmin', () => {
  it('rejects a request with no authorization header as 401', async () => {
    const res = await request(app).get('/api/admin/jobs');
    expect(res.status).toBe(401);
  });

  it('rejects a malformed authorization header as 401', async () => {
    const res = await request(app).get('/api/admin/jobs').set('Authorization', 'admin-token');
    expect(res.status).toBe(401);
  });

  it('rejects an unverifiable token as 401', async () => {
    const res = await request(app).get('/api/admin/jobs').set('Authorization', 'Bearer nonsense');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('invalid-token');
  });

  // The reason the group check is done by hand rather than via aws-jwt-verify's
  // `groups` option: a valid token for a non-admin must be distinguishable from
  // a bad token, or the UI bounces that person to the sign-in screen forever.
  it('rejects a valid token without the admin group as 403, NOT 401', async () => {
    const res = await request(app).get('/api/admin/jobs').set('Authorization', 'Bearer user-token');
    expect(res.status).toBe(403);
    expect(res.status).not.toBe(401);
    expect(res.body.code).toBe('not-admin');
    expect(res.body.error).toContain('admins');
  });

  it('rejects a token carrying some other group as 403', async () => {
    const res = await request(app).get('/api/admin/jobs').set('Authorization', 'Bearer other-group-token');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('not-admin');
  });

  it('accepts cognito:groups as an array', async () => {
    const res = await request(app).get('/api/admin/jobs').set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(200);
  });

  it('accepts cognito:groups as a string', async () => {
    const res = await request(app).get('/api/admin/jobs').set('Authorization', 'Bearer admin-token-string-groups');
    expect(res.status).toBe(200);
  });

  it('logs an audit record when access is denied', async () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await request(app).get('/api/admin/jobs').set('Authorization', 'Bearer user-token');

    const records = spy.mock.calls
      .map(([line]) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((record) => record && record.type === 'admin-audit');

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      action: 'access-denied',
      outcome: 'refused',
      actor: { email: 'one@example.com' }
    });
    spy.mockRestore();
  });
});

describe('GET /api/admin/me', () => {
  it('returns the signed-in identity and bucket for an admin', async () => {
    const res = await request(app).get('/api/admin/me').set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      email: 'admin@example.com',
      sub: 'admin-sub',
      bucketName: 'mock-bucket',
      region: 'eu-west-2'
    });
  });

  it('is 403 for a non-admin', async () => {
    const res = await request(app).get('/api/admin/me').set('Authorization', 'Bearer user-token');
    expect(res.status).toBe(403);
  });
});

describe('unknown API routes', () => {
  it('404s as JSON rather than falling through to the static handler', async () => {
    const res = await request(app).get('/api/admin/nope').set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });
});
