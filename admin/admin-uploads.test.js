const support = require('./test-support');
support.setEnv();

jest.mock('@aws-sdk/client-s3', () => require('./test-support').s3Mock());
jest.mock('@aws-sdk/s3-request-presigner', () => require('./test-support').presignerMock());
jest.mock('aws-jwt-verify', () => require('./test-support').jwtVerifyMock());
jest.mock('@aws-sdk/client-cognito-identity-provider', () => require('./test-support').cognitoMock());

const request = require('supertest');
const app = require('./app');
const { invalidate } = require('./lib/jobs');
const { parseUploadKey, metaKeyFor } = require('./lib/uploads');

const AUTH = ['Authorization', 'Bearer admin-token'];
const get = (path) => request(app).get(path).set(...AUTH);
const del = (path, body) => request(app).delete(path).set(...AUTH).send(body);

const CAR = 'uploads/1700000000000_car.stl';
const WING = 'uploads/1700000000111_wing.stl';

beforeEach(() => {
  support.reset();
  invalidate();
});

describe('parseUploadKey', () => {
  it('recovers the original name and the upload time from the key', () => {
    expect(parseUploadKey('uploads/1700000000000_car.stl')).toEqual({
      originalName: 'car.stl',
      uploadedAt: new Date(1700000000000).toISOString()
    });
  });

  it('keeps underscores that are part of the name', () => {
    expect(parseUploadKey('uploads/1700000000000_my_car_v2.stl').originalName).toBe('my_car_v2.stl');
  });

  it('copes with a key that has no timestamp prefix', () => {
    expect(parseUploadKey('uploads/legacy.stl')).toEqual({ originalName: 'legacy.stl', uploadedAt: null });
  });
});

describe('GET /api/admin/uploads', () => {
  it('lists .stl objects and ignores everything else', async () => {
    support.putObject(CAR, 'solid car');
    support.putObject('uploads/1700000000222_notes.txt', 'not geometry');
    support.putObject(metaKeyFor(CAR), { fileKey: CAR, userEmail: 'one@example.com' });

    const res = await get('/api/admin/uploads');
    expect(res.status).toBe(200);
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0].originalName).toBe('car.stl');
  });

  it('matches .STL case-insensitively', async () => {
    support.putObject('uploads/1700000000000_CAR.STL', 'solid');
    const res = await get('/api/admin/uploads');
    expect(res.body.files).toHaveLength(1);
  });

  // The three attribution states, which are three different strengths of claim.
  it('marks a file with a sidecar as "uploaded-by"', async () => {
    support.putObject(CAR, 'solid');
    support.putObject(metaKeyFor(CAR), {
      fileKey: CAR, originalName: 'car.stl', userSub: 'user-sub-1', userEmail: 'one@example.com'
    });

    const res = await get('/api/admin/uploads');
    expect(res.body.files[0].attribution).toBe('uploaded-by');
    expect(res.body.files[0].uploader.email).toBe('one@example.com');
  });

  it('falls back to "first-simulated-by" when only jobs reference the file', async () => {
    support.putObject(CAR, 'solid');
    support.putJob(support.makeJob({ jobId: 'job-1700000000001-aaaaaaaa', fileKey: CAR, userEmail: 'two@example.com' }));

    const res = await get('/api/admin/uploads');
    expect(res.body.files[0].attribution).toBe('first-simulated-by');
    expect(res.body.files[0].usedBy.map((u) => u.email)).toEqual(['two@example.com']);
    expect(res.body.files[0].runCount).toBe(1);
  });

  it('marks a never-simulated file with no sidecar as orphaned', async () => {
    support.putObject(CAR, 'solid');

    const res = await get('/api/admin/uploads');
    expect(res.body.files[0].attribution).toBe('orphaned');
    expect(res.body.files[0].uploader).toBeNull();
    expect(res.body.files[0].usedBy).toEqual([]);
    expect(res.body.unusedCount).toBe(1);
    expect(res.body.unusedBytes).toBe('solid'.length);
  });

  // The cleanup list is about references, not attribution: a recorded upload
  // that nothing has simulated is just as reclaimable as an orphaned one.
  it('counts a recorded-but-never-simulated upload as unused', async () => {
    support.putObject(CAR, 'solid');
    support.putObject(metaKeyFor(CAR), {
      fileKey: CAR, originalName: 'car.stl', userSub: 'user-sub-1', userEmail: 'one@example.com'
    });

    const res = await get('/api/admin/uploads');
    expect(res.body.files[0].attribution).toBe('uploaded-by');
    expect(res.body.unusedCount).toBe(1);
    expect(res.body.unusedBytes).toBe('solid'.length);
  });

  it('filters to unused files on request', async () => {
    support.putObject(CAR, 'solid');
    support.putObject(WING, 'solid');
    support.putJob(support.makeJob({ jobId: 'job-1700000000001-aaaaaaaa', fileKey: WING }));

    const res = await get('/api/admin/uploads?unused=1');
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0].fileKey).toBe(CAR);
    expect(res.body.total).toBe(2);
  });

  // The fileKey written into job.json is passed through a sanitiser. On a real
  // upload key that sanitiser is a no-op, which is what makes this exact-string
  // join safe — pin it so a change to either regex is caught here.
  it('joins job.fileKey to the upload key exactly', async () => {
    const key = 'uploads/1700000000000_my-car_v2.stl';
    support.putObject(key, 'solid');
    support.putJob(support.makeJob({ jobId: 'job-1700000000001-aaaaaaaa', fileKey: key }));

    const res = await get('/api/admin/uploads');
    expect(res.body.files[0].runCount).toBe(1);
  });

  it('reports jobs whose geometry has been deleted', async () => {
    support.putJob(support.makeJob({ jobId: 'job-1700000000001-aaaaaaaa', fileKey: CAR }));

    const res = await get('/api/admin/uploads');
    expect(res.body.files).toHaveLength(0);
    expect(res.body.missing).toHaveLength(1);
    expect(res.body.missing[0].fileKey).toBe(CAR);
    expect(res.body.missing[0].runCount).toBe(1);
  });

  it('reports a sidecar whose upload never completed', async () => {
    support.putObject(metaKeyFor(CAR), { fileKey: CAR, userEmail: 'one@example.com' });

    const res = await get('/api/admin/uploads');
    expect(res.body.files).toHaveLength(0);
    expect(res.body.stale).toEqual([{ metaKey: `uploads-meta/1700000000000_car.stl.json`, fileKey: CAR }]);
  });

  it('paginates past the 1000-key listing limit', async () => {
    for (let i = 0; i < 1100; i++) {
      support.putObject(`uploads/17000000${String(i).padStart(5, '0')}_part.stl`, 'solid');
    }
    const res = await get('/api/admin/uploads');
    expect(res.body.files).toHaveLength(1100);
  });
});

describe('GET /api/admin/uploads/download', () => {
  it('presigns with the original filename as an attachment', async () => {
    support.putObject(CAR, 'solid');
    const res = await get(`/api/admin/uploads/download?key=${encodeURIComponent(CAR)}`);

    expect(res.status).toBe(200);
    expect(res.body.filename).toBe('car.stl');
    expect(decodeURIComponent(res.body.url)).toContain('attachment; filename="car.stl"');
  });

  it.each([
    ['results/job-1700000000001-aaaaaaaa/job.json', 'a key outside uploads/'],
    ['uploads/../results/secret', 'a traversing key'],
    ['uploads/', 'the bare prefix'],
    ['', 'an empty key']
  ])('rejects %s (%s)', async (key) => {
    const res = await get(`/api/admin/uploads/download?key=${encodeURIComponent(key)}`);
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/admin/uploads', () => {
  it('removes the file and its sidecar', async () => {
    support.putObject(CAR, 'solid');
    support.putObject(metaKeyFor(CAR), { fileKey: CAR, userEmail: 'one@example.com' });

    const res = await del(`/api/admin/uploads?key=${encodeURIComponent(CAR)}`, { confirm: 'car.stl' });
    expect(res.status).toBe(200);
    expect(res.body.sidecarRemoved).toBe(true);
    expect(support.has(CAR)).toBe(false);
    expect(support.has(metaKeyFor(CAR))).toBe(false);
  });

  it('succeeds for a file that has no sidecar', async () => {
    support.putObject(CAR, 'solid');
    const res = await del(`/api/admin/uploads?key=${encodeURIComponent(CAR)}`, { confirm: 'car.stl' });
    expect(res.status).toBe(200);
    expect(support.has(CAR)).toBe(false);
  });

  it('refuses when the typed name does not match', async () => {
    support.putObject(CAR, 'solid');
    const res = await del(`/api/admin/uploads?key=${encodeURIComponent(CAR)}`, { confirm: 'wrong.stl' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('confirm-mismatch');
    expect(support.has(CAR)).toBe(true);
  });

  // A file still in use is confirmed on its full key: a higher bar for the
  // delete that breaks something.
  it('requires the full key when simulations still reference the file', async () => {
    support.putObject(CAR, 'solid');
    support.putJob(support.makeJob({ jobId: 'job-1700000000001-aaaaaaaa', fileKey: CAR }));

    const byName = await del(`/api/admin/uploads?key=${encodeURIComponent(CAR)}`, { confirm: 'car.stl' });
    expect(byName.status).toBe(400);
    expect(support.has(CAR)).toBe(true);

    const byKey = await del(`/api/admin/uploads?key=${encodeURIComponent(CAR)}`, { confirm: CAR });
    expect(byKey.status).toBe(200);
    expect(support.has(CAR)).toBe(false);
  });

  it('refuses a key outside uploads/ and leaves results untouched', async () => {
    support.putJob(support.makeJob({ jobId: 'job-1700000000001-aaaaaaaa' }));

    const res = await del('/api/admin/uploads?key=results%2Fjob-1700000000001-aaaaaaaa%2Fjob.json', {
      confirm: 'job.json'
    });
    expect(res.status).toBe(400);
    expect(support.has('results/job-1700000000001-aaaaaaaa/job.json')).toBe(true);
  });

  it('audits the delete', async () => {
    support.putObject(CAR, 'solid');
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await del(`/api/admin/uploads?key=${encodeURIComponent(CAR)}`, { confirm: 'car.stl' });

    const records = spy.mock.calls
      .map(([line]) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((record) => record && record.type === 'admin-audit');

    expect(records[0]).toMatchObject({
      action: 'delete-upload',
      outcome: 'success',
      target: CAR,
      actor: { email: 'admin@example.com' }
    });
    spy.mockRestore();
  });
});
