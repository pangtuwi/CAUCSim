// Force mock mode and mock authentication for API testing
process.env.S3_BUCKET_NAME = '';
process.env.COGNITO_USER_POOL_ID = '';
process.env.COGNITO_CLIENT_ID = '';

const request = require('supertest');
const app = require('./app');
const fs = require('fs');
const path = require('path');

describe('CAUCSim API Tests (Mock Mode & Auth)', () => {
  const uploadDir = path.join(__dirname, 'uploads');
  let testFileKey = '';
  const authHeaderValue = 'Bearer mock-session-token';

  beforeAll(() => {
    // Ensure the mock uploads directory exists
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
  });

  afterAll(() => {
    // Clean up test files if any remain
    if (testFileKey && fs.existsSync(path.join(uploadDir, testFileKey))) {
      fs.unlinkSync(path.join(uploadDir, testFileKey));
    }
  });

  describe('GET /api/status (Public Endpoint)', () => {
    it('should return online status and storage configuration', async () => {
      const response = await request(app).get('/api/status');
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'online');
      expect(response.body).toHaveProperty('storage', 'local-mock');
      expect(response.body).toHaveProperty('authMode', 'mock');
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
      expect(response.body).toHaveProperty('error', 'Invalid mock session token');
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

    it('should generate upload and view URLs in mock mode', async () => {
      const response = await request(app)
        .post('/api/get-upload-url')
        .set('Authorization', authHeaderValue)
        .send({ filename: 'test-car.stl', fileType: 'model/stl' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('uploadUrl');
      expect(response.body).toHaveProperty('viewUrl');
      expect(response.body).toHaveProperty('fileKey');

      // Save fileKey for subsequent tests
      const urlParts = response.body.uploadUrl.split('/');
      testFileKey = urlParts[urlParts.length - 1];
    });
  });

  describe('PUT /api/mock-upload/:fileKey', () => {
    it('should reject invalid file keys', async () => {
      const response = await request(app)
        .put('/api/mock-upload/foo..bar.stl')
        .set('Authorization', authHeaderValue)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('dummy data'));

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error', 'Invalid mock file key');
    });

    it('should write file to local mock storage', async () => {
      expect(testFileKey).not.toBe('');

      const fileData = Buffer.from('mock stl content');
      const response = await request(app)
        .put(`/api/mock-upload/${testFileKey}`)
        .set('Authorization', authHeaderValue)
        .set('Content-Type', 'application/octet-stream')
        .send(fileData);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('message', 'File written to local mock storage');

      // Verify file was written
      const filePath = path.join(uploadDir, testFileKey);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath).toString()).toBe('mock stl content');
    });
  });

  describe('GET /api/files', () => {
    it('should list STL files from mock storage', async () => {
      const response = await request(app)
        .get('/api/files')
        .set('Authorization', authHeaderValue);
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);

      // Ensure our uploaded file is in the list
      const uploadedFile = response.body.find(f => f.fileKey === `uploads/${testFileKey}`);
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

    it('should delete the specified file', async () => {
      expect(testFileKey).not.toBe('');

      const response = await request(app)
        .delete(`/api/files/uploads/${testFileKey}`)
        .set('Authorization', authHeaderValue);
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('message', 'File deleted from local mock storage');

      // Verify file was deleted
      const filePath = path.join(uploadDir, testFileKey);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('should return 404 if file does not exist', async () => {
      const response = await request(app)
        .delete('/api/files/uploads/non-existent-file.stl')
        .set('Authorization', authHeaderValue);
      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error', 'File not found');
    });
  });
});
