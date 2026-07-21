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

// Detect if running in AWS Lambda vs local machine
const isLambda = !!process.env.LAMBDA_TASK_ROOT;

// Dynamically set directory path (/tmp for AWS Lambda, local folder for dev)
const uploadDir = isLambda 
  ? path.join('/tmp', 'uploads') 
  : path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Serve frontend static assets with cache-busting headers
app.use(express.static('public', {
  etag: true,
  lastModified: true,
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    }
  }
}));
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

// AWS Cognito Configuration
const userPoolId = process.env.COGNITO_USER_POOL_ID;
const clientId = process.env.COGNITO_CLIENT_ID;

// Force Cognito auth mode in production/Lambda environments to prevent mock bypass vulnerabilities
const isProduction = process.env.NODE_ENV === 'production' || isLambda;
const useCognito = isProduction || !!(userPoolId && clientId);

const { CognitoJwtVerifier } = require("aws-jwt-verify");
let verifier = null;

if (useCognito) {
  if (userPoolId && clientId) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: userPoolId,
      tokenUse: "id",
      clientId: clientId
    });
    console.log("AWS Cognito Authentication initialized.");
  } else {
    console.error("FATAL ERROR: AWS Cognito environment variables (COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID) are missing in production!");
  }
} else {
  console.warn("WARNING: AWS Cognito credentials not configured. Running in Mock Authentication Mode.");
}

// Authentication Middleware
const requireAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid authorization header" });
  }
  
  const token = authHeader.split(" ")[1];
  
  if (!useCognito) {
    // Mock Auth Mode: Accept a dummy token
    if (token === "mock-session-token") {
      req.user = { email: "developer@cauc.local" };
      return next();
    }
    return res.status(401).json({ error: "Invalid mock session token" });
  }
  
  // Cognito Auth Mode
  if (!verifier) {
    return res.status(500).json({ error: "Cognito authentication is enabled but not configured on the server." });
  }
  
  try {
    const payload = await verifier.verify(token);
    req.user = {
      email: payload.email,
      sub: payload.sub
    };
    next();
  } catch (err) {
    console.error("JWT Verification failed:", err.message);
    res.status(401).json({ error: "Unauthorized: Invalid token" });
  }
};

// --- API Endpoints ---

// 0. Get System Status & Storage configuration
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    storage: useMockS3 ? 'local-mock' : 'aws-s3',
    bucket: bucketName || null,
    region: region,
    authMode: useCognito ? 'cognito' : 'mock',
    cognito: useCognito ? { clientId, region } : null
  });
});

// 1. Get Presigned Upload and Download URLs
app.post('/api/get-upload-url', requireAuth, async (req, res) => {
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
app.put('/api/mock-upload/:fileKey', requireAuth, express.raw({ type: '*/*', limit: '500mb' }), (req, res) => {
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
app.get('/api/files', requireAuth, async (req, res) => {
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
app.delete('/api/files/*fileKey', requireAuth, async (req, res) => {
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


// --- CFD Job Orchestration Helpers & Endpoints ---
const crypto = require('crypto');

// Save a job file (log or zip) to local mock directory or S3
const saveJobFile = async (jobId, filename, content, contentType) => {
  if (useMockS3) {
    const jobFolder = path.join(uploadDir, 'results', jobId);
    if (!fs.existsSync(jobFolder)) {
      fs.mkdirSync(jobFolder, { recursive: true });
    }
    fs.writeFileSync(path.join(jobFolder, filename), content);
  } else {
    const putCommand = new PutObjectCommand({
      Bucket: bucketName,
      Key: `results/${jobId}/${filename}`,
      Body: content,
      ContentType: contentType || 'text/plain'
    });
    await s3Client.send(putCommand);
  }
};

// Save job state JSON to S3 or local directory
const saveJobState = async (jobId, state) => {
  state.updatedAt = new Date().toISOString();
  if (useMockS3) {
    const jobFolder = path.join(uploadDir, 'results', jobId);
    if (!fs.existsSync(jobFolder)) {
      fs.mkdirSync(jobFolder, { recursive: true });
    }
    fs.writeFileSync(path.join(jobFolder, 'job.json'), JSON.stringify(state, null, 2));
  } else {
    const putCommand = new PutObjectCommand({
      Bucket: bucketName,
      Key: `results/${jobId}/job.json`,
      Body: JSON.stringify(state, null, 2),
      ContentType: 'application/json'
    });
    await s3Client.send(putCommand);
  }
};

// Read job state JSON from S3 or local directory
const getJobState = async (jobId) => {
  if (useMockS3) {
    const jobPath = path.join(uploadDir, 'results', jobId, 'job.json');
    if (!fs.existsSync(jobPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(jobPath, 'utf8'));
    } catch (e) {
      return null;
    }
  } else {
    try {
      const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: `results/${jobId}/job.json`
      });
      const response = await s3Client.send(getCommand);
      const data = await response.Body.transformToString();
      return JSON.parse(data);
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.code === 'NoSuchKey') return null;
      throw err;
    }
  }
};

// Simulated CFD runner for Local Mock Mode
const runSimulatedJob = async (jobId, frontalArea) => {
  const isTest = process.env.NODE_ENV === 'test';
  const steps = [
    { stage: 'mesh_generation', delay: isTest ? 0 : 2000, log: '==> Running surfaceFeatures...\nGenerating eMesh files...\n==> Running blockMesh...\nGenerated background mesh...\n==> Running decomposePar...\nDecomposed domain into 16 subdomains.\n' },
    { stage: 'solving', delay: isTest ? 0 : 4000, log: '==> Running snappyHexMesh...\nCreated hex-dominant mesh...\n==> Running potentialFoam...\nInitialized pressure field...\n==> Running foamRun (solving simpleFoam)...\nTime = 100, residuals: p=0.001, U=0.0004\nTime = 200, residuals: p=0.0005, U=0.0001\nTime = 300, residuals: p=0.0001, U=0.00005\nTime = 400, residuals: p=0.00005, U=0.00001\nTime = 500, residuals: p=0.00001, U=0.000008\n' },
    { stage: 'processing_results', delay: isTest ? 0 : 4000, log: '==> Running reconstructPar...\nReconstructed mesh and fields.\n==> Calculating aerodynamic forces...\nParsed forceCoeffs.dat.\n==> Packaging results into results.zip...\n' }
  ];

  let cumulativeLog = '==> Initialization complete. Starting simulated OpenFOAM run.\n';
  await saveJobFile(jobId, 'simulation.log', cumulativeLog, 'text/plain');

  for (const step of steps) {
    await new Promise(resolve => setTimeout(resolve, step.delay));
    const jobState = await getJobState(jobId);
    if (!jobState || jobState.status === 'failed') return;

    jobState.stage = step.stage;
    jobState.status = 'running';
    await saveJobState(jobId, jobState);

    cumulativeLog += step.log;
    await saveJobFile(jobId, 'simulation.log', cumulativeLog, 'text/plain');
  }

  // Finalize simulation metrics
  await new Promise(resolve => setTimeout(resolve, isTest ? 0 : 2000));
  const jobState = await getJobState(jobId);
  if (!jobState || jobState.status === 'failed') return;

  const cd = (0.26 + Math.random() * 0.04).toFixed(3);
  const cl = (-0.15 + Math.random() * 0.05).toFixed(3);
  const cm = (0.01 + Math.random() * 0.01).toFixed(3);
  const aref = parseFloat(frontalArea) || 0.15;
  const cda = (cd * aref).toFixed(4);
  const cla = (cl * aref).toFixed(4);
  const raceSpeed = 13.4;
  const dragForce = (0.5 * 1.225 * Math.pow(raceSpeed, 2) * cda).toFixed(1);
  const liftForce = (0.5 * 1.225 * Math.pow(raceSpeed, 2) * cla).toFixed(1);
  const aeroPower = (dragForce * raceSpeed).toFixed(0);

  jobState.status = 'completed';
  jobState.stage = 'completed';
  jobState.completedAt = new Date().toISOString();
  jobState.metrics = {
    cd: parseFloat(cd),
    cl: parseFloat(cl),
    cm: parseFloat(cm),
    cda: parseFloat(cda),
    cla: parseFloat(cla),
    aref: aref,
    dragForce: parseFloat(dragForce),
    liftForce: parseFloat(liftForce),
    aeroPower: parseFloat(aeroPower)
  };

  await saveJobState(jobId, jobState);

  cumulativeLog += '==> Simulation completed successfully!\n=============================================\n';
  cumulativeLog += `Cd            : ${cd}\nCl            : ${cl}\nCm            : ${cm}\nCdA           : ${cda} m²\nClA           : ${cla} m²\n`;
  cumulativeLog += `At race speed (${raceSpeed} m/s):\n`;
  cumulativeLog += `  Drag force  : ${dragForce} N\n  Lift force  : ${liftForce} N\n  Aero power  : ${aeroPower} W\n=============================================\n`;
  
  await saveJobFile(jobId, 'simulation.log', cumulativeLog, 'text/plain');
  await saveJobFile(jobId, 'results.zip', Buffer.from('mock results zip content'), 'application/zip');
};

// 1. POST /api/jobs: Queue/start simulation
app.post('/api/jobs', requireAuth, async (req, res) => {
  const { fileKey, frontalArea } = req.body;
  if (!fileKey) {
    return res.status(400).json({ error: 'fileKey is required' });
  }

  const cleanFileKey = fileKey.replace(/[^a-zA-Z0-9./_-]/g, '_');
  const jobId = `job-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const jobToken = crypto.randomBytes(16).toString('hex');
  const originalName = fileKey.substring(fileKey.indexOf('_') + 1);

  const initialJobState = {
    jobId,
    fileKey: cleanFileKey,
    originalName,
    status: 'queued',
    stage: 'initializing',
    error: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    dropletId: null,
    jobToken,
    metrics: null
  };

  try {
    await saveJobState(jobId, initialJobState);

    const doToken = process.env.DIGITALOCEAN_TOKEN;
    const doSnapshotName = process.env.DIGITALOCEAN_SNAPSHOT_NAME || 'openfoam-base';
    
    // Check if DO credentials are provided, if not fallback to simulated run
    if (!doToken || useMockS3) {
      console.log(`Starting simulated CFD job ${jobId}...`);
      if (process.env.NODE_ENV !== 'test') {
        runSimulatedJob(jobId, frontalArea).catch(err => {
          console.error("Simulated Job failed in background:", err);
        });
      }
      
      const clientState = { ...initialJobState };
      delete clientState.jobToken;
      return res.json(clientState);
    }

    // Real DigitalOcean launch
    console.log(`Provisioning DigitalOcean droplet for job ${jobId}...`);
    
    // Resolve Snapshot ID
    let snapshotId = process.env.DIGITALOCEAN_IMAGE_ID;
    if (!snapshotId) {
      const imagesRes = await fetch('https://api.digitalocean.com/v2/images?private=true', {
        headers: { 'Authorization': `Bearer ${doToken}` }
      });
      if (!imagesRes.ok) {
        throw new Error(`Failed to query DigitalOcean images: ${await imagesRes.text()}`);
      }
      const imagesData = await imagesRes.json();
      const snapshot = (imagesData.images || []).find(img => img.name === doSnapshotName);
      if (snapshot) {
        snapshotId = snapshot.id;
      }
    }
    
    if (!snapshotId) {
      throw new Error(`Could not resolve image snapshot '${doSnapshotName}'`);
    }

    // Resolve SSH Key Fingerprints
    let sshKeys = [];
    if (process.env.DIGITALOCEAN_SSH_KEY_FP) {
      sshKeys.push(process.env.DIGITALOCEAN_SSH_KEY_FP);
    } else {
      const sshRes = await fetch('https://api.digitalocean.com/v2/ssh_keys', {
        headers: { 'Authorization': `Bearer ${doToken}` }
      });
      if (sshRes.ok) {
        const sshData = await sshRes.json();
        if (sshData.ssh_keys && sshData.ssh_keys.length > 0) {
          sshKeys.push(sshData.ssh_keys[0].fingerprint);
        }
      }
    }

    // Compile Cloud-Init (User Data Script)
    const callbackUrl = process.env.APP_CALLBACK_URL || `${req.protocol}://${req.get('host')}`;
    const userDataScript = `#!/bin/bash
set -e
exec > >(tee -ia /var/log/cloud-init-output.log) 2>&1

JOB_ID="${jobId}"
JOB_TOKEN="${jobToken}"
CALLBACK_URL="${callbackUrl}/api/jobs/${jobId}/callback"
S3_BUCKET="${bucketName}"
STL_KEY="${cleanFileKey}"
TEMPLATE_KEY="case-template.zip"
AWS_REGION="${region}"

# Export AWS credentials immediately so all subshells/background loops inherit them
export AWS_ACCESS_KEY_ID="${process.env.AWS_ACCESS_KEY_ID || ''}"
export AWS_SECRET_ACCESS_KEY="${process.env.AWS_SECRET_ACCESS_KEY || ''}"
export AWS_DEFAULT_REGION="\$AWS_REGION"

# Start background safety self-destruct timer (1 hour = 3600s)
(
  sleep 3600
  echo "==> [SAFETY TIMEOUT] 1 hour elapsed. Self-destructing droplet..."
  DROPLET_ID=\$(curl -s http://169.254.169.254/metadata/v1/id)
  curl -s -X DELETE \\
       -H "Authorization: Bearer ${doToken}" \\
       "https://api.digitalocean.com/v2/droplets/\$DROPLET_ID"
) &

# Periodically push active log to S3 (every 5 seconds) quiet and redirected to prevent log loops
(
  while true; do
    if [ -f /root/cfd_run/simulation.log ]; then
      aws s3 cp /root/cfd_run/simulation.log "s3://\$S3_BUCKET/results/\$JOB_ID/simulation.log" --content-type "text/plain" --quiet || true
    elif [ -f /var/log/cloud-init-output.log ]; then
      aws s3 cp /var/log/cloud-init-output.log "s3://\$S3_BUCKET/results/\$JOB_ID/simulation.log" --content-type "text/plain" --quiet || true
    fi
    sleep 5
  done
) >/dev/null 2>&1 &
LOG_SYNC_PID=\$!

# Helper function to update job state in S3 and callback URL
update_job_status() {
  local status="\$1"
  local stage="\$2"
  local error="\$3"
  local metrics="\$4"
  
  # Fetch current state to preserve other fields, or initialize template
  aws s3 cp "s3://\$S3_BUCKET/results/\$JOB_ID/job.json" current_job.json || echo '{"jobId":"'\$JOB_ID'"}' > current_job.json
  
  python3 -c "
import json
try:
    with open('current_job.json', 'r') as f:
        data = json.load(f)
except Exception:
    data = {}
data['status'] = '\$status'
data['stage'] = '\$stage'
data['updatedAt'] = '\$(date -u +%Y-%m-%dT%H:%M:%SZ)'
if '\$error':
    data['error'] = '\$error'
if '\$metrics':
    try:
        data['metrics'] = json.loads('''\$metrics''')
    except Exception as e:
        data['error'] = 'Failed to parse metrics: ' + str(e)
with open('updated_job.json', 'w') as f:
    json.dump(data, f, indent=2)
"
  # Push updated state file back to S3
  aws s3 cp updated_job.json "s3://\$S3_BUCKET/results/\$JOB_ID/job.json" --content-type "application/json" || true
  
  # Execute fallback callback to local server (if accessible)
  curl -s -X POST "\$CALLBACK_URL" \\
       -H "Content-Type: application/json" \\
       -H "X-Job-Token: \$JOB_TOKEN" \\
       -d "{\\"status\\": \\"\$status\\", \\"stage\\": \\"\$stage\\" \$( [ -n \\"\$error\\" ] && echo \\", \\\\\\\"error\\\\\\\": \\\\\\\"\$error\\\\\\\"\\" || echo \\"\\" ) \$( [ -n \\"\$metrics\\" ] && echo \\", \\\\\\\"metrics\\\\\\\": \$metrics\\" || echo \\"\\" )}" || true
}

# Install zip, unzip and curl utilities immediately on boot
echo "==> Installing system packages..."
apt-get update && apt-get install -y unzip zip curl

# Install official AWS CLI v2
echo "==> Installing AWS CLI v2..."
curl -s "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip -q awscliv2.zip
./aws/install
rm -rf awscliv2.zip aws/

# AWS CLI credentials are already configured and exported at boot

# Notify API Server: Droplet booted, starting setup
update_job_status "running" "initializing"

# Create run directory
mkdir -p /root/cfd_run
cd /root/cfd_run

# Download case template and user STL file from S3
echo "==> Downloading case template from S3..."
aws s3 cp "s3://\$S3_BUCKET/\$TEMPLATE_KEY" ./template.zip

echo "==> Extracting case template..."
unzip -o template.zip
rm template.zip

# Adjust Allrun shebang to bash and insert solver status update
sed -i '1s|#!/bin/sh|#!/bin/bash|' Allrun
sed -i '/==> potentialFoam/i update_job_status "running" "solving"' Allrun

# Ensure geometry folder exists
mkdir -p constant/geometry

echo "==> Downloading STL geometry..."
aws s3 cp "s3://\$S3_BUCKET/\$STL_KEY" constant/geometry/Basic_F24.stl

# Notify API Server: Starting meshing
update_job_status "running" "mesh_generation"

# Load OpenFOAM environment (disable set -e temporarily to ignore harmless shell context warnings)
export OMPI_ALLOW_RUN_AS_ROOT=1 
export OMPI_ALLOW_RUN_AS_ROOT_CONFIRM=1
set +e
source /opt/openfoam13/etc/bashrc
set -e

# Export helper function and variables so children (Allrun) can access them
export -f update_job_status
export JOB_ID JOB_TOKEN CALLBACK_URL S3_BUCKET

# Run execution pipeline
echo "==> Running OpenFOAM pipeline..."
chmod +x Allrun
./Allrun > simulation.log 2>&1 || {
  echo "==> Simulation failed!"
  aws s3 cp simulation.log "s3://\$S3_BUCKET/results/\$JOB_ID/simulation.log"
  update_job_status "failed" "solving" "OpenFOAM execution failed"
  
  # Terminate log sync background process
  kill \$LOG_SYNC_PID || true
  
  # Self destruct
  DROPLET_ID=\$(curl -s http://169.254.169.254/metadata/v1/id)
  curl -s -X DELETE \\
       -H "Authorization: Bearer ${doToken}" \\
       "https://api.digitalocean.com/v2/droplets/\$DROPLET_ID"
  exit 1
}

# Notify API Server: Run completed, processing results
update_job_status "running" "processing_results"

# Compress results (excluding processor directories to save space/bandwidth)
echo "==> Packaging results..."
zip -r results.zip 0/ constant/ system/ postProcessing/ simulation.log -x "processor*" || true

# Upload results back to S3
echo "==> Uploading results to S3..."
aws s3 cp results.zip "s3://\$S3_BUCKET/results/\$JOB_ID/results.zip"
aws s3 cp simulation.log "s3://\$S3_BUCKET/results/\$JOB_ID/simulation.log"
if [ -f postProcessing/forceCoeffs/0/forceCoeffs.dat ]; then
  aws s3 cp postProcessing/forceCoeffs/0/forceCoeffs.dat "s3://\$S3_BUCKET/results/\$JOB_ID/forceCoeffs.dat"
fi

# Calculate force coefficients and compile aerodynamic metrics
METRICS_JSON="{}"
COEFFS_FILE="postProcessing/forceCoeffs/0/forceCoeffs.dat"
if [ -f "\$COEFFS_FILE" ]; then
  METRICS_JSON=\$(python3 - <<EOF
import json
try:
    with open("\$COEFFS_FILE", "r") as f:
        lines = [line.strip() for line in f if line.strip() and not line.startswith("#")]
    if lines:
        last_line = lines[-1].split()
        time = float(last_line[0])
        cm = float(last_line[1])
        cd = float(last_line[2])
        cl = float(last_line[3])
        
        # Extract headers if present
        aref = 1.0
        with open("\$COEFFS_FILE", "r") as f:
            for line in f:
                if "# Aref" in line:
                    aref = float(line.split()[-1])
                    break
        
        cda = cd * aref
        cla = cl * aref
        
        print(json.dumps({
            "cd": cd,
            "cl": cl,
            "cm": cm,
            "cda": cda,
            "cla": cla,
            "aref": aref
        }))
    else:
        print("{}")
except Exception as e:
    print(json.dumps({"error": str(e)}))
EOF
)
fi

# Notify API Server: Finished!
update_job_status "completed" "completed" "" "\$METRICS_JSON"

# Terminate log sync background process
kill \$LOG_SYNC_PID || true

# Hard Self-Destruct to stop billing
echo "==> Self-destructing droplet..."
DROPLET_ID=\$(curl -s http://169.254.169.254/metadata/v1/id)
curl -s -X DELETE \\
     -H "Authorization: Bearer ${doToken}" \\
     "https://api.digitalocean.com/v2/droplets/\$DROPLET_ID"
`;

    // Trigger Droplet Creation
    const dropletPayload = {
      name: `caucsim-cfd-${jobId}`,
      region: process.env.DIGITALOCEAN_REGION || 'lon1',
      size: process.env.DIGITALOCEAN_SIZE || 'gd-16vcpu-64gb',
      image: snapshotId,
      ssh_keys: sshKeys,
      backups: false,
      ipv6: false,
      user_data: userDataScript,
      tags: ['cfd-runner']
    };

    const doResponse = await fetch('https://api.digitalocean.com/v2/droplets', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${doToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(dropletPayload)
    });

    if (!doResponse.ok) {
      const errText = await doResponse.text();
      throw new Error(`DigitalOcean Droplet creation failed: ${errText}`);
    }

    const doData = await doResponse.json();
    const dropletId = doData.droplet.id;

    // Assign resource to Project
    const doProjectId = process.env.DIGITALOCEAN_PROJECT_ID || 'efc7b19b-24a6-4149-bc96-4e90a71cdbd1';
    if (doProjectId) {
      await fetch(`https://api.digitalocean.com/v2/projects/${doProjectId}/resources`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${doToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          resources: [`do:droplet:${dropletId}`]
        })
      });
    }

    initialJobState.dropletId = dropletId;
    initialJobState.status = 'running';
    initialJobState.stage = 'initializing';
    await saveJobState(jobId, initialJobState);

    const clientState = { ...initialJobState };
    delete clientState.jobToken;
    res.json(clientState);

  } catch (err) {
    console.error("Failed to start CFD Job:", err);
    res.status(500).json({ error: `Failed to initiate CFD job: ${err.message}` });
  }
});

// 2. GET /api/jobs: List history of runs
app.get('/api/jobs', requireAuth, async (req, res) => {
  if (useMockS3) {
    const resultsDir = path.join(uploadDir, 'results');
    if (!fs.existsSync(resultsDir)) {
      return res.json([]);
    }
    try {
      const folders = fs.readdirSync(resultsDir);
      const jobs = [];
      for (const folder of folders) {
        const jobPath = path.join(resultsDir, folder, 'job.json');
        if (fs.existsSync(jobPath)) {
          try {
            const jobData = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
            const clientState = { ...jobData };
            delete clientState.jobToken;
            jobs.push(clientState);
          } catch (e) {}
        }
      }
      jobs.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
      res.json(jobs);
    } catch (err) {
      res.status(500).json({ error: 'Failed to list local mock jobs' });
    }
  } else {
    try {
      const listCommand = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: 'results/'
      });
      const data = await s3Client.send(listCommand);
      const jobKeys = (data.Contents || [])
        .filter(item => item.Key.endsWith('job.json'))
        .map(item => item.Key);
      
      const jobs = await Promise.all(
        jobKeys.map(async key => {
          const getCommand = new GetObjectCommand({
            Bucket: bucketName,
            Key: key
          });
          const response = await s3Client.send(getCommand);
          const raw = await response.Body.transformToString();
          const jobData = JSON.parse(raw);
          const clientState = { ...jobData };
          delete clientState.jobToken;
          return clientState;
        })
      );
      jobs.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
      res.json(jobs);
    } catch (err) {
      console.error("S3 List Jobs Error:", err);
      res.status(500).json({ error: 'Failed to list jobs from S3' });
    }
  }
});

// 3. GET /api/jobs/:id: Fetch job metadata
app.get('/api/jobs/:id', requireAuth, async (req, res) => {
  const jobId = req.params.id;
  const jobState = await getJobState(jobId);
  if (!jobState) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  // Check if the job is orphaned
  let stateChanged = false;
  if (jobState.status === 'queued' || jobState.status === 'running') {
    if (jobState.dropletId) {
      const doToken = process.env.DIGITALOCEAN_TOKEN;
      if (doToken) {
        try {
          const doRes = await fetch(`https://api.digitalocean.com/v2/droplets/${jobState.dropletId}`, {
            headers: { 'Authorization': `Bearer ${doToken}` }
          });
          if (doRes.status === 404) {
            jobState.status = 'failed';
            jobState.error = 'DigitalOcean droplet was destroyed or is no longer active.';
            jobState.completedAt = new Date().toISOString();
            jobState.updatedAt = new Date().toISOString();
            stateChanged = true;
          } else if (doRes.ok) {
            const doData = await doRes.json();
            const dropletStatus = doData.droplet && doData.droplet.status;
            if (dropletStatus === 'off' || dropletStatus === 'archive') {
              jobState.status = 'failed';
              jobState.error = `DigitalOcean droplet is inactive (status: ${dropletStatus}).`;
              jobState.completedAt = new Date().toISOString();
              jobState.updatedAt = new Date().toISOString();
              stateChanged = true;
            }
          }
        } catch (err) {
          console.error(`Error verifying droplet ${jobState.dropletId} status:`, err);
        }
      }
    } else {
      // Simulated/Mock job or failed launch (no dropletId)
      const timeSinceUpdate = Date.now() - new Date(jobState.updatedAt).getTime();
      if (timeSinceUpdate > 60000) { // 1 minute timeout for local/failed queued jobs
        jobState.status = 'failed';
        jobState.error = 'Simulation job was interrupted or failed to start.';
        jobState.completedAt = new Date().toISOString();
        jobState.updatedAt = new Date().toISOString();
        stateChanged = true;
      }
    }
  }

  if (stateChanged) {
    await saveJobState(jobId, jobState);
  }

  const clientState = { ...jobState };
  delete clientState.jobToken;
  res.json(clientState);
});

// 4. POST /api/jobs/:id/callback: Droplet status callback
app.post('/api/jobs/:id/callback', async (req, res) => {
  const jobId = req.params.id;
  const token = req.headers['x-job-token'];
  
  const jobState = await getJobState(jobId);
  if (!jobState) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  if (jobState.jobToken !== token) {
    return res.status(401).json({ error: 'Unauthorized: Invalid job token' });
  }
  
  const { status, stage, error, metrics } = req.body;
  if (status) jobState.status = status;
  if (stage) jobState.stage = stage;
  if (error) jobState.error = error;
  if (metrics) {
    if (metrics.cda) {
      const raceSpeed = 13.4;
      metrics.dragForce = parseFloat((0.5 * 1.225 * Math.pow(raceSpeed, 2) * metrics.cda).toFixed(1));
      if (metrics.cla) {
        metrics.liftForce = parseFloat((0.5 * 1.225 * Math.pow(raceSpeed, 2) * metrics.cla).toFixed(1));
      }
      metrics.aeroPower = parseFloat((metrics.dragForce * raceSpeed).toFixed(0));
    }
    jobState.metrics = metrics;
  }
  
  if (status === 'completed' || status === 'failed') {
    jobState.completedAt = new Date().toISOString();
  }
  
  await saveJobState(jobId, jobState);
  res.json({ message: 'Job state updated' });
});

// 5. GET /api/jobs/:id/log: Stream simulation.log from S3 or local disk
app.get('/api/jobs/:id/log', requireAuth, async (req, res) => {
  const jobId = req.params.id;
  if (useMockS3) {
    const logPath = path.join(uploadDir, 'results', jobId, 'simulation.log');
    if (!fs.existsSync(logPath)) {
      return res.status(404).json({ error: 'Log not found' });
    }
    return res.sendFile(logPath);
  } else {
    try {
      const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: `results/${jobId}/simulation.log`
      });
      const response = await s3Client.send(getCommand);
      const logText = await response.Body.transformToString();
      res.setHeader('Content-Type', 'text/plain');
      res.send(logText);
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.code === 'NoSuchKey') {
        return res.status(404).json({ error: 'Log file not found on S3' });
      }
      console.error("Failed to retrieve log from S3:", err);
      res.status(500).json({ error: 'Failed to retrieve log from S3' });
    }
  }
});

// 6. GET /api/jobs/:id/download: Redirect or download results.zip
app.get('/api/jobs/:id/download', requireAuth, async (req, res) => {
  const jobId = req.params.id;
  if (useMockS3) {
    const zipPath = path.join(uploadDir, 'results', jobId, 'results.zip');
    if (!fs.existsSync(zipPath)) {
      return res.status(404).json({ error: 'Results file not found' });
    }
    return res.sendFile(zipPath);
  } else {
    try {
      const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: `results/${jobId}/results.zip`
      });
      const url = await getSignedUrl(s3Client, getCommand, { expiresIn: 3600 });
      res.redirect(url);
    } catch (err) {
      res.status(500).json({ error: 'Failed to generate results download URL' });
    }
  }
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}

module.exports = app;
module.exports.handler = serverless(app, {
  binary: ['image/*', 'application/zip', 'application/octet-stream']
});