// Mock environment variables before importing app
process.env.S3_BUCKET_NAME = 'mock-bucket';
process.env.COGNITO_USER_POOL_ID = 'us-east-1_mockpool';
process.env.COGNITO_CLIENT_ID = 'mockclient';
process.env.DIGITALOCEAN_TOKEN = 'mock-do-token';
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
const app = require('./app');

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

    it('should redirect to visualisation signed URL if it exists', async () => {
      mockInMemoryS3[`results/${testJobId}/flow_slice.png`] = Buffer.from('mock png data');

      const response = await request(app)
        .get(`/api/jobs/${testJobId}/visualisation`)
        .set('Authorization', authHeaderValue);
      
      expect(response.status).toBe(302);
      expect(response.headers.location).toContain('https://mock-s3-presigned-url.com/results/');
      expect(response.headers.location).toContain('/flow_slice.png');
    });
  });
});
