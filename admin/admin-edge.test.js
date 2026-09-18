// Edge cases in how the two S3 prefixes are parsed. These are the places where
// a stray object could otherwise invent a job id or a phantom upload record.
const support = require('./test-support');
support.setEnv();

jest.mock('@aws-sdk/client-s3', () => require('./test-support').s3Mock());
jest.mock('@aws-sdk/s3-request-presigner', () => require('./test-support').presignerMock());
jest.mock('aws-jwt-verify', () => require('./test-support').jwtVerifyMock());
jest.mock('@aws-sdk/client-cognito-identity-provider', () => require('./test-support').cognitoMock());

const request = require('supertest');
const app = require('./app');
const { invalidate } = require('./lib/jobs');
const { mapWithConcurrency } = require('./lib/concurrency');

const AUTH = ['Authorization', 'Bearer admin-token'];
const get = (path) => request(app).get(path).set(...AUTH);

beforeEach(() => {
  support.reset();
  invalidate();
});

describe('mapWithConcurrency', () => {
  it('preserves input order regardless of completion order', async () => {
    const input = [30, 10, 20, 0, 40];
    const result = await mapWithConcurrency(input, 3, async (value) => {
      await new Promise((resolve) => setTimeout(resolve, value / 10));
      return value;
    });
    expect(result).toEqual(input);
  });

  it('never exceeds the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 50 }, (unused, i) => i), 4, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 8, async () => 1)).toEqual([]);
  });
});

describe('stray objects under results/', () => {
  it('ignores an object sitting directly under the prefix', async () => {
    support.putObject('results/stray-notes.txt', 'nothing to do with a job');
    support.putJob(support.makeJob({ jobId: 'job-1700000000001-aaaaaaaa' }));

    const res = await get('/api/admin/jobs');
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.jobs[0].jobId).toBe('job-1700000000001-aaaaaaaa');
  });

  it('does not count a stray object as an artifact of any job', async () => {
    support.putObject('results/stray.txt', 'x');
    support.putJob(support.makeJob({ jobId: 'job-1700000000001-aaaaaaaa' }));

    const res = await get('/api/admin/jobs/job-1700000000001-aaaaaaaa');
    expect(res.body.artifacts.map((a) => a.name)).not.toContain('stray.txt');
  });
});

describe('stray objects under uploads-meta/', () => {
  it('ignores a non-JSON object in the metadata prefix', async () => {
    support.putObject('uploads-meta/README', 'not a record');
    support.putObject('uploads/1700000000000_car.stl', 'solid');

    const res = await get('/api/admin/uploads');
    expect(res.status).toBe(200);
    expect(res.body.stale).toEqual([]);
    expect(res.body.files[0].attribution).toBe('orphaned');
  });

  it('falls back to inferred attribution when a sidecar is corrupt', async () => {
    support.putObject('uploads/1700000000000_car.stl', 'solid');
    support.putObject('uploads-meta/1700000000000_car.stl.json', '{ truncated');
    support.putJob(support.makeJob({
      jobId: 'job-1700000000001-aaaaaaaa', fileKey: 'uploads/1700000000000_car.stl', userEmail: 'two@example.com'
    }));

    const res = await get('/api/admin/uploads');
    expect(res.status).toBe(200);
    expect(res.body.files[0].attribution).toBe('first-simulated-by');
  });
});

describe('jobs with unusual records', () => {
  it('handles a job.json with no user attached', async () => {
    support.putJob(support.makeJob({
      jobId: 'job-1700000000001-aaaaaaaa', userSub: undefined, userEmail: undefined
    }));

    const res = await get('/api/admin/jobs');
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.jobs[0].userEmail).toBeUndefined();
  });

  it('handles a job directory with no job.json at all', async () => {
    support.putObject('results/job-1700000000001-aaaaaaaa/results.zip', 'zip');

    const res = await get('/api/admin/jobs');
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(0);
    expect(res.body.malformed).toHaveLength(0);
  });

  it('sorts newest first by default', async () => {
    support.putJob(support.makeJob({ jobId: 'job-1700000000001-aaaaaaaa', startedAt: '2026-01-01T00:00:00.000Z' }));
    support.putJob(support.makeJob({ jobId: 'job-1700000000002-bbbbbbbb', startedAt: '2026-03-01T00:00:00.000Z' }));
    support.putJob(support.makeJob({ jobId: 'job-1700000000003-cccccccc', startedAt: '2026-02-01T00:00:00.000Z' }));

    const res = await get('/api/admin/jobs');
    expect(res.body.jobs.map((job) => job.jobId)).toEqual([
      'job-1700000000002-bbbbbbbb',
      'job-1700000000003-cccccccc',
      'job-1700000000001-aaaaaaaa'
    ]);
  });
});
