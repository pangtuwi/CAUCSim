const support = require('./test-support');
support.setEnv();

jest.mock('@aws-sdk/client-s3', () => require('./test-support').s3Mock());
jest.mock('@aws-sdk/s3-request-presigner', () => require('./test-support').presignerMock());
jest.mock('aws-jwt-verify', () => require('./test-support').jwtVerifyMock());
jest.mock('@aws-sdk/client-cognito-identity-provider', () => require('./test-support').cognitoMock());

const request = require('supertest');
const app = require('./app');
const { invalidate } = require('./lib/jobs');

const AUTH = ['Authorization', 'Bearer admin-token'];
const get = (path) => request(app).get(path).set(...AUTH);
const del = (path, body) => request(app).delete(path).set(...AUTH).send(body);

beforeEach(() => {
  support.reset();
  invalidate();
});

describe('GET /api/admin/jobs', () => {
  it('returns jobs belonging to every user, not just the caller', async () => {
    support.putJob(support.makeJob({ jobId: 'job-1700000000001-aaaaaaaa', userSub: 'user-sub-1', userEmail: 'one@example.com' }));
    support.putJob(support.makeJob({ jobId: 'job-1700000000002-bbbbbbbb', userSub: 'user-sub-2', userEmail: 'two@example.com' }));
    support.putJob(support.makeJob({ jobId: 'job-1700000000003-cccccccc', userSub: 'user-sub-3', userEmail: 'three@example.com' }));

    const res = await get('/jobs'.replace(/^/, '/api/admin'));
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(3);
    expect(new Set(res.body.jobs.map((job) => job.userEmail)))
      .toEqual(new Set(['one@example.com', 'two@example.com', 'three@example.com']));
  });

  // The droplet callback secret. If this ever appears in a response, any user
  // who can read it can forge job state transitions.
  it('never exposes jobToken', async () => {
    support.putJob(support.makeJob({ jobId: 'job-1700000000001-aaaaaaaa' }));

    for (const path of [
      '/api/admin/jobs',
      '/api/admin/jobs/job-1700000000001-aaaaaaaa',
      '/api/admin/jobs/job-1700000000001-aaaaaaaa/job.json'
    ]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain('jobToken');
      expect(res.text).not.toContain('SUPER-SECRET-CALLBACK-TOKEN');
    }
  });

  // The behaviour that makes this app different from GET /api/jobs in the CFD
  // backend, which stops at the first 1000 keys without saying so.
  it('paginates past the 1000-key listing limit', async () => {
    for (let i = 0; i < 400; i++) {
      support.putJob(
        support.makeJob({ jobId: `job-17000000${String(i).padStart(5, '0')}-aaaaaaaa` }),
        { artifacts: ['results.zip', 'simulation.log'] }
      );
    }
    // 400 jobs x 3 keys = 1200 keys, i.e. two listing pages.
    expect(support.keys().length).toBe(1200);

    const res = await get('/api/admin/jobs');
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(400);
    expect(res.body.total).toBe(400);
  });

  it('reports an unparseable job.json instead of failing the whole listing', async () => {
    support.putJob(support.makeJob({ jobId: 'job-1700000000001-aaaaaaaa' }));
    support.putObject('results/job-1700000000002-bbbbbbbb/job.json', '{ not json');

    const res = await get('/api/admin/jobs');
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.malformed).toHaveLength(1);
    expect(res.body.malformed[0].key).toBe('results/job-1700000000002-bbbbbbbb/job.json');
  });

  it('counts artifacts and bytes per job', async () => {
    support.putJob(support.makeJob({ jobId: 'job-1700000000001-aaaaaaaa' }));
    const res = await get('/api/admin/jobs');
    // job.json + the three default artifacts
    expect(res.body.jobs[0].artifactCount).toBe(4);
    expect(res.body.jobs[0].totalBytes).toBeGreaterThan(0);
  });

  it('filters by status and by user, and searches free text', async () => {
    support.putJob(support.makeJob({ jobId: 'job-1700000000001-aaaaaaaa', status: 'completed', userEmail: 'one@example.com', runName: 'Alpha wing' }));
    support.putJob(support.makeJob({ jobId: 'job-1700000000002-bbbbbbbb', status: 'failed', userEmail: 'two@example.com', runName: 'Beta nose' }));

    expect((await get('/api/admin/jobs?status=failed')).body.jobs).toHaveLength(1);
    expect((await get('/api/admin/jobs?user=one@example.com')).body.jobs).toHaveLength(1);
    expect((await get('/api/admin/jobs?q=beta')).body.jobs).toHaveLength(1);
    expect((await get('/api/admin/jobs?q=nothing-matches')).body.jobs).toHaveLength(0);
  });
});

describe('GET /api/admin/jobs/:jobId', () => {
  it('returns the job with its artifact listing', async () => {
    support.putJob(support.makeJob({ jobId: 'job-1700000000001-aaaaaaaa' }));
    const res = await get('/api/admin/jobs/job-1700000000001-aaaaaaaa');
    expect(res.status).toBe(200);
    expect(res.body.job.jobId).toBe('job-1700000000001-aaaaaaaa');
    expect(res.body.artifacts.map((a) => a.name).sort())
      .toEqual(['flow_slice.png', 'job.json', 'results.zip', 'simulation.log']);
  });

  it('404s for an unknown job', async () => {
    const res = await get('/api/admin/jobs/job-1700000000009-ffffffff');
    expect(res.status).toBe(404);
  });

  it('400s on a malformed job id', async () => {
    for (const bad of ['not-a-job', 'job-abc-12345678', 'job-1700000000001-ZZZZZZZZ', 'results']) {
      const res = await get(`/api/admin/jobs/${bad}`);
      expect(res.status).toBe(400);
    }
  });

  // Traversal is stopped before the route by Express path normalisation, so
  // the status is 404 rather than 400 — what matters is that it never reaches
  // S3 with a crafted key.
  it('never serves a traversing job id', async () => {
    for (const bad of ['..', '../..', '%2e%2e%2f']) {
      const res = await get(`/api/admin/jobs/${bad}`);
      expect([400, 404]).toContain(res.status);
    }
  });
});

describe('downloads', () => {
  beforeEach(() => support.putJob(support.makeJob({ jobId: 'job-1700000000001-aaaaaaaa' })));

  it('presigns an artifact as an attachment', async () => {
    const res = await get('/api/admin/jobs/job-1700000000001-aaaaaaaa/download?file=results.zip');
    expect(res.status).toBe(200);
    expect(res.body.url).toContain('results/job-1700000000001-aaaaaaaa/results.zip');
    expect(decodeURIComponent(res.body.url)).toContain('attachment; filename=');
  });

  it('defaults to results.zip', async () => {
    const res = await get('/api/admin/jobs/job-1700000000001-aaaaaaaa/download');
    expect(res.body.url).toContain('results.zip');
  });

  it('404s for an artifact this job does not have', async () => {
    const res = await get('/api/admin/jobs/job-1700000000001-aaaaaaaa/download?file=nope.png');
    expect(res.status).toBe(404);
  });

  it('rejects a traversing file name', async () => {
    const res = await get('/api/admin/jobs/job-1700000000001-aaaaaaaa/download?file=..%2F..%2Fsecret');
    expect(res.status).toBe(400);
  });

  // A presigned URL serves the RAW object, which still holds jobToken. job.json
  // must therefore be served by the app from the stripped copy, never signed.
  it('refuses to presign job.json', async () => {
    const res = await get('/api/admin/jobs/job-1700000000001-aaaaaaaa/download?file=job.json');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('never presigned');
  });

  it('serves job.json directly, with the token stripped', async () => {
    const res = await get('/api/admin/jobs/job-1700000000001-aaaaaaaa/job.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(JSON.parse(res.text).jobToken).toBeUndefined();
  });

  it('serves the simulation log as plain text', async () => {
    const res = await get('/api/admin/jobs/job-1700000000001-aaaaaaaa/log');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('simulation.log');
  });
});

describe('DELETE /api/admin/jobs/:jobId', () => {
  const JOB_ID = 'job-1700000000001-aaaaaaaa';

  it('removes every key under the job prefix and nothing else', async () => {
    support.putJob(support.makeJob({ jobId: JOB_ID }));
    support.putJob(support.makeJob({ jobId: 'job-1700000000002-bbbbbbbb' }));
    support.putObject('uploads/1700000000000_car.stl', 'solid');

    const res = await del(`/api/admin/jobs/${JOB_ID}`, { confirm: JOB_ID });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(4);

    expect(support.keys().some((key) => key.startsWith(`results/${JOB_ID}/`))).toBe(false);
    expect(support.has('results/job-1700000000002-bbbbbbbb/job.json')).toBe(true);
    expect(support.has('uploads/1700000000000_car.stl')).toBe(true);
  });

  it('refuses without the typed confirmation and deletes nothing', async () => {
    support.putJob(support.makeJob({ jobId: JOB_ID }));

    const res = await del(`/api/admin/jobs/${JOB_ID}`, { confirm: 'wrong' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('confirm-mismatch');
    expect(support.has(`results/${JOB_ID}/job.json`)).toBe(true);
  });

  it('refuses a missing confirmation body', async () => {
    support.putJob(support.makeJob({ jobId: JOB_ID }));
    const res = await del(`/api/admin/jobs/${JOB_ID}`);
    expect(res.status).toBe(400);
    expect(support.has(`results/${JOB_ID}/job.json`)).toBe(true);
  });

  // Deleting mid-run does not stop the droplet: it keeps billing and keeps
  // rewriting this prefix. There is deliberately no force override.
  it.each(['running', 'queued'])('refuses to delete a %s job with 409', async (status) => {
    support.putJob(support.makeJob({ jobId: JOB_ID, status, dropletId: 98765 }));

    const res = await del(`/api/admin/jobs/${JOB_ID}`, { confirm: JOB_ID });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('job-in-flight');
    expect(res.body.dropletId).toBe(98765);
    expect(support.has(`results/${JOB_ID}/job.json`)).toBe(true);
  });

  it('has no force override for an in-flight job', async () => {
    support.putJob(support.makeJob({ jobId: JOB_ID, status: 'running' }));
    const res = await del(`/api/admin/jobs/${JOB_ID}?force=true`, { confirm: JOB_ID });
    expect(res.status).toBe(409);
    expect(support.has(`results/${JOB_ID}/job.json`)).toBe(true);
  });

  it('batches a prefix larger than 1000 keys into multiple DeleteObjects calls', async () => {
    const artifacts = Array.from({ length: 1199 }, (unused, i) => `artifact-${i}.dat`);
    support.putJob(support.makeJob({ jobId: JOB_ID }), { artifacts });
    expect(support.keys().length).toBe(1200);

    support.state.counts.deleteObjects = 0;
    const res = await del(`/api/admin/jobs/${JOB_ID}`, { confirm: JOB_ID });

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1200);
    expect(support.state.counts.deleteObjects).toBe(2);
    expect(support.keys()).toHaveLength(0);
  });

  // DeleteObjects answers 200 with a per-key Errors array. Treating that as
  // success would report a half-deleted prefix as done.
  it('surfaces per-key delete failures rather than reporting success', async () => {
    support.putJob(support.makeJob({ jobId: JOB_ID }));
    support.state.deleteObjectsErrors = [`results/${JOB_ID}/results.zip`];

    const res = await del(`/api/admin/jobs/${JOB_ID}`, { confirm: JOB_ID });
    expect(res.status).toBe(500);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].key).toBe(`results/${JOB_ID}/results.zip`);
  });

  it('writes an audit record naming the actor', async () => {
    support.putJob(support.makeJob({ jobId: JOB_ID }));
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await del(`/api/admin/jobs/${JOB_ID}`, { confirm: JOB_ID });

    const records = spy.mock.calls
      .map(([line]) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((record) => record && record.type === 'admin-audit');

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      action: 'delete-job',
      outcome: 'success',
      target: JOB_ID,
      actor: { sub: 'admin-sub', email: 'admin@example.com' }
    });
    spy.mockRestore();
  });

  it('audits a refused delete too', async () => {
    support.putJob(support.makeJob({ jobId: JOB_ID, status: 'running' }));
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await del(`/api/admin/jobs/${JOB_ID}`, { confirm: JOB_ID });

    const records = spy.mock.calls
      .map(([line]) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((record) => record && record.type === 'admin-audit');

    expect(records[0]).toMatchObject({ action: 'delete-job', outcome: 'refused' });
    spy.mockRestore();
  });
});

describe('job cache', () => {
  it('re-reads S3 after a delete rather than serving the stale snapshot', async () => {
    support.putJob(support.makeJob({ jobId: 'job-1700000000001-aaaaaaaa' }));
    support.putJob(support.makeJob({ jobId: 'job-1700000000002-bbbbbbbb' }));

    expect((await get('/api/admin/jobs')).body.jobs).toHaveLength(2);
    await del('/api/admin/jobs/job-1700000000001-aaaaaaaa', { confirm: 'job-1700000000001-aaaaaaaa' });
    expect((await get('/api/admin/jobs')).body.jobs).toHaveLength(1);
  });
});
