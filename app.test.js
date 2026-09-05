// Mock environment variables before importing app
process.env.S3_BUCKET_NAME = 'mock-bucket';
process.env.COGNITO_USER_POOL_ID = 'us-east-1_mockpool';
process.env.COGNITO_CLIENT_ID = 'mockclient';
process.env.DIGITALOCEAN_TOKEN = 'mock-do-token';
process.env.DIGITALOCEAN_SNAPSHOT_NAME = 'openfoam-base';
process.env.NODE_ENV = 'test';

// mockInMemoryS3 Mock Database
let mockInMemoryS3 = {};

// Mock AWS SDK S3 client
jest.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: jest.fn().mockImplementation(() => {
      return {
        send: jest.fn().mockImplementation(async (command) => {
          const commandName = command.constructor.name;
          const input = command.input;

          if (commandName === 'PutObjectCommand') {
            mockInMemoryS3[input.Key] = input.Body;
            return {};
          }

          if (commandName === 'GetObjectCommand') {
            if (!mockInMemoryS3[input.Key]) {
              const err = new Error('NoSuchKey');
              err.name = 'NoSuchKey';
              err.code = 'NoSuchKey';
              throw err;
            }
            return {
              Body: {
                transformToString: async () => mockInMemoryS3[input.Key].toString()
              }
            };
          }

          if (commandName === 'HeadObjectCommand') {
            if (!mockInMemoryS3[input.Key]) {
              const err = new Error('NotFound');
              err.name = 'NotFound';
              err.code = 'NotFound';
              throw err;
            }
            return {};
          }

          if (commandName === 'ListObjectsV2Command') {
            const contents = Object.keys(mockInMemoryS3)
              .filter(key => key.startsWith(input.Prefix || ''))
              .map(key => ({
                Key: key,
                Size: mockInMemoryS3[key] ? mockInMemoryS3[key].length : 0,
                LastModified: new Date()
              }));
            return { Contents: contents };
          }

          if (commandName === 'DeleteObjectCommand') {
            delete mockInMemoryS3[input.Key];
            return {};
          }

          return {};
        })
      };
    }),
    PutObjectCommand: jest.fn().mockImplementation(function (params) {
      this.constructor = { name: 'PutObjectCommand' };
      this.input = params;
    }),
    GetObjectCommand: jest.fn().mockImplementation(function (params) {
      this.constructor = { name: 'GetObjectCommand' };
      this.input = params;
    }),
    HeadObjectCommand: jest.fn().mockImplementation(function (params) {
      this.constructor = { name: 'HeadObjectCommand' };
      this.input = params;
    }),
    ListObjectsV2Command: jest.fn().mockImplementation(function (params) {
      this.constructor = { name: 'ListObjectsV2Command' };
      this.input = params;
    }),
    DeleteObjectCommand: jest.fn().mockImplementation(function (params) {
      this.constructor = { name: 'DeleteObjectCommand' };
      this.input = params;
    })
  };
});

// Mock S3 signed URL generator
jest.mock('@aws-sdk/s3-request-presigner', () => {
  return {
    getSignedUrl: jest.fn().mockImplementation(async (client, command, options) => {
      const key = command.input.Key;
      return `https://mock-s3-presigned-url.com/${key}`;
    })
  };
});

// Mock Cognito JWT verification
jest.mock('aws-jwt-verify', () => {
  return {
    CognitoJwtVerifier: {
      create: jest.fn().mockImplementation(() => {
        return {
          verify: jest.fn().mockImplementation(async (token) => {
            if (token === 'mock-session-token') {
              return {
                email: 'test@caucsim.co.uk',
                sub: 'mock-user-sub-123'
              };
            }
            throw new Error('Invalid token');
          })
        };
      })
    }
  };
});

// Mock DigitalOcean API requests
global.fetch = jest.fn().mockImplementation(async (url, options) => {
  if (url.includes('/v2/images')) {
    return {
      ok: true,
      json: async () => ({
        images: [
          { name: 'openfoam-base', id: 12345 }
        ]
      })
    };
  }
  if (url.includes('/v2/droplets')) {
    return {
      ok: true,
      json: async () => ({
        droplet: {
          id: 98765
        }
      })
    };
  }
  return { ok: false, text: async () => 'Not Found' };
});

const request = require('supertest');
const app = require('./backend/app/app');

describe('CAUCSim API Tests (Strict Production Mode)', () => {
  const authHeaderValue = 'Bearer mock-session-token';

  beforeAll(() => {
    mockInMemoryS3 = {};
  });

  describe('GET /api/status (Public Endpoint)', () => {
    it('should return online status and storage configuration', async () => {
      const response = await request(app).get('/api/status');
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'online');
      expect(response.body).toHaveProperty('storage', 'aws-s3');
      expect(response.body).toHaveProperty('auth', 'aws-cognito');
    });
  });

  describe('Authorization Rules (All Data Routes Protected)', () => {
    it('should reject GET /api/files without auth header', async () => {
      const response = await request(app).get('/api/files');
      expect(response.status).toBe(401);
    });

    it('should reject POST /api/get-upload-url with invalid token', async () => {
      const response = await request(app)
        .post('/api/get-upload-url')
        .set('Authorization', 'Bearer invalid-token')
        .send({ filename: 'test.stl' });
      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/get-upload-url', () => {
    it('should require a filename', async () => {
      const response = await request(app)
        .post('/api/get-upload-url')
        .set('Authorization', authHeaderValue)
        .send({ fileType: 'application/octet-stream' });
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error', 'Filename is required');
    });

    it('should generate S3 upload and view presigned URLs', async () => {
      const response = await request(app)
        .post('/api/get-upload-url')
        .set('Authorization', authHeaderValue)
        .send({ filename: 'test-car.stl', fileType: 'model/stl' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('uploadUrl');
      expect(response.body).toHaveProperty('viewUrl');
      expect(response.body).toHaveProperty('fileKey');
      expect(response.body.uploadUrl).toContain('https://mock-s3-presigned-url.com/uploads/');
    });
  });

  describe('GET /api/files', () => {
    it('should list STL files from S3 storage', async () => {
      // Seed mock S3 database
      mockInMemoryS3['uploads/12345_test-car.stl'] = Buffer.from('mock stl content');

      const response = await request(app)
        .get('/api/files')
        .set('Authorization', authHeaderValue);
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);

      const uploadedFile = response.body.find(f => f.fileKey === 'uploads/12345_test-car.stl');
      expect(uploadedFile).toBeDefined();
      expect(uploadedFile).toHaveProperty('originalName', 'test-car.stl');
      expect(uploadedFile).toHaveProperty('size', Buffer.from('mock stl content').length);
    });
  });

  describe('DELETE /api/files/*fileKey', () => {
    it('should return 400 for invalid file keys', async () => {
      const response = await request(app)
        .delete('/api/files/uploads/foo..bar.stl')
        .set('Authorization', authHeaderValue);
      expect(response.status).toBe(400);
    });

    it('should return 400 if attempting to delete outside uploads directory', async () => {
      const response = await request(app)
        .delete('/api/files/results/job.json')
        .set('Authorization', authHeaderValue);
      expect(response.status).toBe(400);
    });

    it('should delete the specified file from S3', async () => {
      mockInMemoryS3['uploads/12345_test-car.stl'] = Buffer.from('mock stl content');

      const response = await request(app)
        .delete('/api/files/uploads/12345_test-car.stl')
        .set('Authorization', authHeaderValue);
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('message', 'S3 object deleted successfully');
      expect(mockInMemoryS3['uploads/12345_test-car.stl']).toBeUndefined();
    });
  });

  describe('CFD Job Orchestration Endpoints', () => {
    let testJobId = '';
    let testJobToken = '';

    beforeEach(() => {
      // Seed S3 with the initial job file for the callback/retrieval tests
      if (testJobId) {
        // preserve the job state across tests within the suite
      }
    });

    it('should reject POST /api/jobs without auth', async () => {
      const response = await request(app)
        .post('/api/jobs')
        .send({ fileKey: 'uploads/test-car.stl' });
      expect(response.status).toBe(401);
    });

    it('should trigger a DigitalOcean droplet launch for CFD', async () => {
      const response = await request(app)
        .post('/api/jobs')
        .set('Authorization', authHeaderValue)
        .send({ fileKey: 'uploads/test-car.stl', frontalArea: 0.16 });
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('jobId');
      expect(response.body).toHaveProperty('status', 'running');
      expect(response.body).toHaveProperty('stage', 'initializing');

      testJobId = response.body.jobId;

      // Extract token from mock S3 state
      const stateFile = JSON.parse(mockInMemoryS3[`results/${testJobId}/job.json`].toString());
      testJobToken = stateFile.jobToken;
      expect(stateFile).toHaveProperty('frontalArea', 0.16);
    });

    // Creates a job and hands back the state that was persisted for it.
    const createJobWithState = async (payload) => {
      const response = await request(app)
        .post('/api/jobs')
        .set('Authorization', authHeaderValue)
        .send({ fileKey: 'uploads/test-car.stl', ...payload });
      expect(response.status).toBe(200);
      return JSON.parse(mockInMemoryS3[`results/${response.body.jobId}/job.json`].toString());
    };

    describe('reference geometry parameters', () => {
      it('stores a valid wheelbase and moment centre', async () => {
        const state = await createJobWithState({ wheelbase: 1.42, momentCentreX: 0.75 });
        expect(state).toHaveProperty('wheelbase', 1.42);
        expect(state).toHaveProperty('momentCentreX', 0.75);
      });

      // Absent or nonsense values leave the template's own lRef/CofR standing
      // rather than substituting something wrong.
      it.each([
        ['omitted', {}],
        ['zero', { wheelbase: 0 }],
        ['negative', { wheelbase: -1.42 }],
        ['a string', { wheelbase: '1.42' }],
        ['NaN', { wheelbase: Number.NaN }]
      ])('records a null wheelbase when %s', async (_label, payload) => {
        const state = await createJobWithState(payload);
        expect(state.wheelbase).toBeNull();
      });

      // Unlike the wheelbase, zero is a legitimate moment centre.
      it('accepts a moment centre of zero', async () => {
        const state = await createJobWithState({ momentCentreX: 0 });
        expect(state).toHaveProperty('momentCentreX', 0);
      });
    });

    // The droplet writes job.json to S3 itself and only then curls the callback
    // with "|| true". A callback that never lands (job started against a
    // different APP_CALLBACK_URL, transient network failure) must not cost the
    // user their results, so the coefficients are also derived on read.
    describe('deriving coefficients when the callback never arrived', () => {
      const FORCE_COEFFS = [
        '# Force coefficients',
        '# lRef        : 2.340000e+00',
        '# Aref        : 6.571290e-01',
        '# Time        \tCm            \tCd            \tCl            ',
        '0             \t2.428109e-03\t1.875034e-02\t9.187129e-05',
        '1             \t-7.291676e-02\t6.120765e-01\t-4.958101e-01',
        '2             \t-1.313830e-01\t3.154900e-01\t-1.967192e-01'
      ].join('\n') + '\n';

      const seedCompletedJob = (jobId, extra = {}) => {
        mockInMemoryS3[`results/${jobId}/job.json`] = JSON.stringify({
          jobId,
          status: 'completed',
          stage: 'completed',
          updatedAt: new Date().toISOString(),
          metrics: null,
          raceSpeedMph: 30,
          frontalArea: 0.657129,
          ...extra
        });
      };

      it('derives the metrics from forceCoeffs.dat on read', async () => {
        const jobId = 'job-derive-on-read';
        seedCompletedJob(jobId);
        mockInMemoryS3[`results/${jobId}/forceCoeffs.dat`] = FORCE_COEFFS;

        const response = await request(app)
          .get(`/api/jobs/${jobId}`)
          .set('Authorization', authHeaderValue);

        expect(response.status).toBe(200);
        expect(response.body.metrics).toBeTruthy();
        expect(response.body.metrics.cd).toBeCloseTo(0.315402, 4);
        expect(response.body.metrics.aref).toBeCloseTo(0.657129, 6);
        // Three rows cannot demonstrate convergence.
        expect(response.body.metrics.converged).toBe(false);
        // The forces the results panel shows are derived too.
        expect(response.body.metrics.dragForce).toBeGreaterThan(0);
        expect(response.body.metrics.aeroPower).toBeGreaterThan(0);
      });

      it('records why instead of silently showing nothing when the history is missing', async () => {
        const jobId = 'job-no-history';
        seedCompletedJob(jobId);

        const response = await request(app)
          .get(`/api/jobs/${jobId}`)
          .set('Authorization', authHeaderValue);

        expect(response.status).toBe(200);
        expect(response.body.metrics).toBeFalsy();
        expect(typeof response.body.metricsError).toBe('string');
        expect(response.body.metricsError.length).toBeGreaterThan(0);
      });

      it('does not re-derive for a job that already has metrics', async () => {
        const jobId = 'job-already-has-metrics';
        seedCompletedJob(jobId, { metrics: { cd: 0.999, cl: -0.111 } });
        mockInMemoryS3[`results/${jobId}/forceCoeffs.dat`] = FORCE_COEFFS;

        const response = await request(app)
          .get(`/api/jobs/${jobId}`)
          .set('Authorization', authHeaderValue);

        expect(response.body.metrics.cd).toBe(0.999);
      });

      // A missing force history will not appear later, so don't re-read S3 on
      // every poll of a finished job.
      it('only attempts the derivation once', async () => {
        const jobId = 'job-derive-once';
        seedCompletedJob(jobId);

        await request(app).get(`/api/jobs/${jobId}`).set('Authorization', authHeaderValue);
        const persisted = JSON.parse(mockInMemoryS3[`results/${jobId}/job.json`].toString());
        expect(persisted.metricsChecked).toBe(true);
      });
    });

    describe('GET /api/jobs/:id/summary', () => {
      const seed = (jobId) => {
        mockInMemoryS3[`results/${jobId}/job.json`] = JSON.stringify({
          jobId, status: 'completed', stage: 'completed',
          updatedAt: new Date().toISOString(), originalName: 'my car.stl',
          raceSpeedMph: 30, wheelbase: 1.8, momentCentreX: 1.17, fastCheck: true,
          metricsChecked: true,
          metrics: { cd: 0.282, cl: -0.091, cm: -0.143, cdStd: 0.113, converged: false,
                     sampleCount: 51, iterations: 51, aref: 0.657129 }
        });
      };

      it('requires auth', async () => {
        const response = await request(app).get('/api/jobs/any-job/summary');
        expect(response.status).toBe(401);
      });

      it('404s for an unknown job', async () => {
        const response = await request(app)
          .get('/api/jobs/no-such-job/summary')
          .set('Authorization', authHeaderValue);
        expect(response.status).toBe(404);
      });

      it('serves Markdown as a download', async () => {
        const jobId = 'job-summary-download';
        seed(jobId);

        const response = await request(app)
          .get(`/api/jobs/${jobId}/summary`)
          .set('Authorization', authHeaderValue);

        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toMatch(/text\/markdown/);
        expect(response.headers['content-disposition']).toMatch(/^attachment;/);
        expect(response.text).toContain('# CFD Summary');
        expect(response.text).toContain('0.282 ± 0.113');
      });

      // The model name reaches a filename, so it must not carry spaces or
      // anything that would break the Content-Disposition header.
      it('sanitises the model name into the filename', async () => {
        const jobId = 'job-summary-filename';
        seed(jobId);

        const response = await request(app)
          .get(`/api/jobs/${jobId}/summary`)
          .set('Authorization', authHeaderValue);

        const disposition = response.headers['content-disposition'];
        expect(disposition).toContain(`caucsim-my_car-${jobId}.md`);
        expect(disposition).not.toContain(' car');
      });
    });

    describe('GET /api/jobs/:id/history', () => {
      const HISTORY = '# Time\tCm\tCd\tCl\n1\t-0.05\t0.31\t-0.19\n2\t-0.06\t0.32\t-0.20\n';

      const seed = (jobId, withHistory) => {
        mockInMemoryS3[`results/${jobId}/job.json`] = JSON.stringify({
          jobId, status: 'completed', stage: 'completed', originalName: 'my car.stl',
          updatedAt: new Date().toISOString(), metricsChecked: true, metrics: { cd: 0.31 }
        });
        if (withHistory) mockInMemoryS3[`results/${jobId}/forceCoeffs.dat`] = HISTORY;
      };

      it('requires auth', async () => {
        const response = await request(app).get('/api/jobs/any-job/history');
        expect(response.status).toBe(401);
      });

      it('serves CSV as a download', async () => {
        const jobId = 'job-history-ok';
        seed(jobId, true);

        const response = await request(app)
          .get(`/api/jobs/${jobId}/history`)
          .set('Authorization', authHeaderValue);

        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toMatch(/text\/csv/);
        expect(response.headers['content-disposition']).toContain(`caucsim-my_car-${jobId}-history.csv`);
        expect(response.text.split('\n')[0]).toBe('Time,Cm,Cd,Cl');
      });

      it('404s with an explanation when no history was uploaded', async () => {
        const jobId = 'job-history-missing';
        seed(jobId, false);

        const response = await request(app)
          .get(`/api/jobs/${jobId}/history`)
          .set('Authorization', authHeaderValue);

        expect(response.status).toBe(404);
        expect(response.body.error).toMatch(/force history/i);
      });
    });

    describe('fast check mode', () => {
      it('records an explicit fast check', async () => {
        const state = await createJobWithState({ fastCheck: true });
        expect(state).toHaveProperty('fastCheck', true);
      });

      // Strict boolean: no malformed request may quietly downgrade a run to the
      // coarse mesh and have its output mistaken for a real result.
      it.each([
        ['omitted', {}],
        ['false', { fastCheck: false }],
        ['the string "true"', { fastCheck: 'true' }],
        ['1', { fastCheck: 1 }],
        ['null', { fastCheck: null }]
      ])('defaults to full fidelity when fastCheck is %s', async (_label, payload) => {
        const state = await createJobWithState(payload);
        expect(state).toHaveProperty('fastCheck', false);
      });
    });

    it('should list jobs from S3', async () => {
      const response = await request(app)
        .get('/api/jobs')
        .set('Authorization', authHeaderValue);
      
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      const foundJob = response.body.find(j => j.jobId === testJobId);
      expect(foundJob).toBeDefined();
    });

    it('should retrieve individual job status', async () => {
      const response = await request(app)
        .get(`/api/jobs/${testJobId}`)
        .set('Authorization', authHeaderValue);
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('jobId', testJobId);
    });

    it('should reject droplet callback with invalid token', async () => {
      const response = await request(app)
        .post(`/api/jobs/${testJobId}/callback`)
        .set('X-Job-Token', 'invalid-token')
        .send({ status: 'running', stage: 'solving' });
      
      expect(response.status).toBe(401);
    });

    it('should update job status via droplet callback', async () => {
      const response = await request(app)
        .post(`/api/jobs/${testJobId}/callback`)
        .set('X-Job-Token', testJobToken)
        .send({ 
          status: 'running', 
          stage: 'solving',
          metrics: {
            cd: 0.28,
            cl: -0.12,
            cm: 0.01,
            cda: 0.0448,
            cla: -0.0192,
            aref: 0.16
          }
        });
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('message', 'Job state updated');

      // Verify S3 state updated
      const updatedJob = JSON.parse(mockInMemoryS3[`results/${testJobId}/job.json`].toString());
      expect(updatedJob.status).toBe('running');
      expect(updatedJob.stage).toBe('solving');
      expect(updatedJob.metrics).toHaveProperty('dragForce', 4.9);
    });

    it('should return 404 for log of a non-existent job', async () => {
      const response = await request(app)
        .get('/api/jobs/non-existent-job/log')
        .set('Authorization', authHeaderValue);
      expect(response.status).toBe(404);
    });

    it('should retrieve job log from S3', async () => {
      mockInMemoryS3[`results/${testJobId}/simulation.log`] = Buffer.from('mock S3 log data');

      const response = await request(app)
        .get(`/api/jobs/${testJobId}/log`)
        .set('Authorization', authHeaderValue);
      expect(response.status).toBe(200);
      expect(response.text).toBe('mock S3 log data');
    });

    it('should return 404 for visualisation of a non-existent job', async () => {
      const response = await request(app)
        .get('/api/jobs/non-existent-job/visualisation')
        .set('Authorization', authHeaderValue);
      expect(response.status).toBe(404);
    });

    it('should return 404 if the visualisation image does not exist for an existing job', async () => {
      delete mockInMemoryS3[`results/${testJobId}/flow_slice.png`];

      const response = await request(app)
        .get(`/api/jobs/${testJobId}/visualisation`)
        .set('Authorization', authHeaderValue);
      
      expect(response.status).toBe(404);
      expect(response.body.error).toContain('Visualisation image not found');
    });

    it('should redirect to visualisation signed URL if it exists', async () => {
      mockInMemoryS3[`results/${testJobId}/flow_slice.png`] = Buffer.from('mock png data');

      const response = await request(app)
        .get(`/api/jobs/${testJobId}/visualisation`)
        .set('Authorization', authHeaderValue);

      expect(response.status).toBe(302);
      expect(response.headers.location).toContain('https://mock-s3-presigned-url.com/results/');
      expect(response.headers.location).toContain('/flow_slice.png');
    });

    it('should return 404 for streamlines-image of a non-existent job', async () => {
      const response = await request(app)
        .get('/api/jobs/non-existent-job/streamlines-image')
        .set('Authorization', authHeaderValue);
      expect(response.status).toBe(404);
    });

    it('should return 404 if the streamlines image does not exist for an existing job', async () => {
      delete mockInMemoryS3[`results/${testJobId}/flow_streamlines_3d.png`];

      const response = await request(app)
        .get(`/api/jobs/${testJobId}/streamlines-image`)
        .set('Authorization', authHeaderValue);

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('Streamlines image not found');
    });

    it('should redirect to streamlines-image signed URL if it exists', async () => {
      mockInMemoryS3[`results/${testJobId}/flow_streamlines_3d.png`] = Buffer.from('mock png data');

      const response = await request(app)
        .get(`/api/jobs/${testJobId}/streamlines-image`)
        .set('Authorization', authHeaderValue);

      expect(response.status).toBe(302);
      expect(response.headers.location).toContain('https://mock-s3-presigned-url.com/results/');
      expect(response.headers.location).toContain('/flow_streamlines_3d.png');
    });

    it('should return 404 for streamlines-model of a non-existent job', async () => {
      const response = await request(app)
        .get('/api/jobs/non-existent-job/streamlines-model')
        .set('Authorization', authHeaderValue);
      expect(response.status).toBe(404);
    });

    it('should return 404 if the streamlines model does not exist for an existing job', async () => {
      delete mockInMemoryS3[`results/${testJobId}/flow_3d_streamlines.gltf`];

      const response = await request(app)
        .get(`/api/jobs/${testJobId}/streamlines-model`)
        .set('Authorization', authHeaderValue);

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('Streamlines model not found');
    });

    it('should redirect to streamlines-model signed URL if it exists', async () => {
      mockInMemoryS3[`results/${testJobId}/flow_3d_streamlines.gltf`] = Buffer.from('mock gltf data');

      const response = await request(app)
        .get(`/api/jobs/${testJobId}/streamlines-model`)
        .set('Authorization', authHeaderValue);

      expect(response.status).toBe(302);
      expect(response.headers.location).toContain('https://mock-s3-presigned-url.com/results/');
      expect(response.headers.location).toContain('/flow_3d_streamlines.gltf');
    });

    it('should redirect to download signed URL when json query param is not provided', async () => {
      const response = await request(app)
        .get(`/api/jobs/${testJobId}/download`)
        .set('Authorization', authHeaderValue);

      expect(response.status).toBe(302);
      expect(response.headers.location).toContain('https://mock-s3-presigned-url.com/results/');
      expect(response.headers.location).toContain('/results.zip');
    });
  });
});
