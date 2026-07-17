// Conditionally load dotenv for local development (skipped in production/Lambda)
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express = require('express');
const serverless = require('serverless-http');
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();
const port = process.env.PORT || 3000;

// Enable JSON body parsing for API requests
app.use(express.json());

// Set up local directories (fallback for mock mode and frontend serving)
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Serve frontend static assets
app.use(express.static('public'));
app.use('/uploads', express.static(uploadDir));

// AWS S3 Configuration
const bucketName = process.env.S3_BUCKET_NAME;
const region = process.env.AWS_REGION || 'eu-west-2';

let s3Client = null;
let useMockS3 = false;

if (!bucketName) {
  console.warn("WARNING: S3_BUCKET_NAME is not configured. Running in Local Disk Mock Mode.");
  useMockS3 = true;
} else {
  s3Client = new S3Client({ region });
}

// --- API Endpoints ---

// 0. Get System Status & Storage configuration
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    storage: useMockS3 ? 'local-mock' : 'aws-s3',
    bucket: bucketName || null,
    region: region
  });
});

// 1. Get Presigned Upload and Download URLs
app.post('/api/get-upload-url', async (req, res) => {
  const { filename, fileType } = req.body;
  if (!filename) {
    return res.status(400).json({ error: 'Filename is required' });
  }

  const cleanName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const uniqueKey = `${Date.now()}_${cleanName}`;
  const s3Key = `uploads/${uniqueKey}`;

  if (useMockS3) {
    // Local Mock S3 Mode
    // Return relative paths pointing back to local mock server
    res.json({
      uploadUrl: `/api/mock-upload/${uniqueKey}`,
      viewUrl: `/uploads/${uniqueKey}`,
      fileKey: s3Key
    });
  } else {
    // Production AWS S3 Mode
    try {
      // Generate PUT presigned URL for direct uploading
      const putCommand = new PutObjectCommand({
        Bucket: bucketName,
        Key: s3Key,
        ContentType: fileType || 'application/octet-stream'
      });
      const uploadUrl = await getSignedUrl(s3Client, putCommand, { expiresIn: 300 });

      // Generate GET presigned URL for direct downloading/viewing in Three.js
      const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: s3Key
      });
      const viewUrl = await getSignedUrl(s3Client, getCommand, { expiresIn: 3600 });

      res.json({ uploadUrl, viewUrl, fileKey: s3Key });
    } catch (err) {
      console.error("S3 Signing Error:", err);
      res.status(500).json({ error: 'Failed to generate S3 presigned URLs' });
    }
  }
});

// Mock S3 PUT upload handler (used only in local disk mock mode)
app.put('/api/mock-upload/:fileKey', express.raw({ type: '*/*', limit: '500mb' }), (req, res) => {
  if (!useMockS3) {
    return res.status(400).json({ error: 'Mock upload is only supported in Mock Mode' });
  }
  const fileKey = req.params.fileKey;
  if (fileKey.includes('..') || fileKey.includes('/') || fileKey.includes('\\')) {
    return res.status(400).json({ error: 'Invalid mock file key' });
  }
  
  const filePath = path.join(uploadDir, fileKey);
  fs.writeFile(filePath, req.body, (err) => {
    if (err) {
      console.error("Mock Write Error:", err);
      return res.status(500).json({ error: 'Failed to write file to mock storage' });
    }
    res.json({ message: 'File written to local mock storage' });
  });
});

// 2. Get Geometry Library List
app.get('/api/files', async (req, res) => {
  if (useMockS3) {
    // Local Mock S3 Mode
    fs.readdir(uploadDir, (err, files) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to read local library' });
      }
      const stlFiles = files
        .filter(file => file.toLowerCase().endsWith('.stl'))
        .map(file => {
          const filePath = path.join(uploadDir, file);
          const stats = fs.statSync(filePath);
          return {
            fileKey: `uploads/${file}`,
            originalName: file.substring(file.indexOf('_') + 1),
            size: stats.size,
            uploadedAt: stats.mtime,
            viewUrl: `/uploads/${file}`
          };
        })
        .sort((a, b) => b.uploadedAt - a.uploadedAt);
      res.json(stlFiles);
    });
  } else {
    // Production AWS S3 Mode
    try {
      const listCommand = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: 'uploads/'
      });
      const data = await s3Client.send(listCommand);
      
      const s3Files = await Promise.all((data.Contents || [])
        .filter(item => item.Key.toLowerCase().endsWith('.stl'))
        .map(async item => {
          // Generate a fresh presigned GET URL for viewing this file
          const getCommand = new GetObjectCommand({
            Bucket: bucketName,
            Key: item.Key
          });
          const viewUrl = await getSignedUrl(s3Client, getCommand, { expiresIn: 3600 });
          
          // Reconstruct original name: strip "uploads/" prefix and Date.now() timestamp
          const keyWithoutPrefix = item.Key.replace('uploads/', '');
          const originalName = keyWithoutPrefix.substring(keyWithoutPrefix.indexOf('_') + 1);

          return {
            fileKey: item.Key,
            originalName: originalName,
            size: item.Size,
            uploadedAt: item.LastModified,
            viewUrl: viewUrl
          };
        })
      );
      s3Files.sort((a, b) => b.uploadedAt - a.uploadedAt);
      res.json(s3Files);
    } catch (err) {
      console.error("S3 List Error:", err);
      res.status(500).json({ error: 'Failed to list files from S3' });
    }
  }
});

// 3. Delete Geometry File (supports sub-paths/folders like uploads/...)
app.delete('/api/files/*fileKey', async (req, res) => {
  let fileKey = req.params.fileKey;
  if (Array.isArray(fileKey)) {
    fileKey = fileKey.join('/');
  }
  if (!fileKey || fileKey.includes('..')) {
    return res.status(400).json({ error: 'Invalid file key' });
  }

  if (useMockS3) {
    // Local Mock S3 Mode
    const filename = fileKey.replace('uploads/', '');
    const filePath = path.join(uploadDir, filename);
    fs.unlink(filePath, (err) => {
      if (err) {
        if (err.code === 'ENOENT') {
          return res.status(404).json({ error: 'File not found' });
        }
        return res.status(500).json({ error: 'Failed to delete local mock file' });
      }
      res.json({ message: 'File deleted from local mock storage' });
    });
  } else {
    // Production AWS S3 Mode
    try {
      const deleteCommand = new DeleteObjectCommand({
        Bucket: bucketName,
        Key: fileKey
      });
      await s3Client.send(deleteCommand);
      res.json({ message: 'S3 object deleted successfully' });
    } catch (err) {
      console.error("S3 Delete Error:", err);
      res.status(500).json({ error: 'Failed to delete S3 object' });
    }
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

module.exports.handler = serverless(app);