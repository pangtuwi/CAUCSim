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

// AWS S3 Configuration
const bucketName = process.env.S3_BUCKET_NAME;
const region = process.env.AWS_REGION || 'eu-west-2';

if (!bucketName) {
  throw new Error("FATAL ERROR: S3_BUCKET_NAME is not configured.");
}
const s3Client = new S3Client({ region });

// AWS Cognito Configuration
const userPoolId = process.env.COGNITO_USER_POOL_ID;
const clientId = process.env.COGNITO_CLIENT_ID;

if (!userPoolId || !clientId) {
  throw new Error("FATAL ERROR: AWS Cognito environment variables (COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID) are missing!");
}

const { CognitoJwtVerifier } = require("aws-jwt-verify");
const verifier = CognitoJwtVerifier.create({
  userPoolId: userPoolId,
  tokenUse: "id",
  clientId: clientId
});
console.log("AWS Cognito Authentication initialized.");

// Authentication Middleware
const requireAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid authorization header" });
  }
  
  const token = authHeader.split(" ")[1];
  
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
    storage: 'aws-s3',
    auth: 'aws-cognito',
    bucketName: bucketName,
    region: region,
    cognito: { clientId: clientId, region: region }
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
});

// 2. Get Geometry Library List
app.get('/api/files', requireAuth, async (req, res) => {
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
});


// --- CFD Job Orchestration Helpers & Endpoints ---
const crypto = require('crypto');

const saveJobFile = async (jobId, filename, content, contentType) => {
  const putCommand = new PutObjectCommand({
    Bucket: bucketName,
    Key: `results/${jobId}/${filename}`,
    Body: content,
    ContentType: contentType || 'text/plain'
  });
  await s3Client.send(putCommand);
};

const saveJobState = async (jobId, state) => {
  state.updatedAt = new Date().toISOString();
  const putCommand = new PutObjectCommand({
    Bucket: bucketName,
    Key: `results/${jobId}/job.json`,
    Body: JSON.stringify(state, null, 2),
    ContentType: 'application/json'
  });
  await s3Client.send(putCommand);
};

const getJobState = async (jobId) => {
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
    if (!doToken) {
      return res.status(400).json({ error: 'DigitalOcean credentials are not configured on the server. Cannot run CFD simulation.' });
    }
    const doSnapshotName = process.env.DIGITALOCEAN_SNAPSHOT_NAME || 'openfoam-base';

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

# Find and upload flow visualisation slice image
echo "==> Searching for flow slice image..."
FLOW_IMAGE=\$(find postProcessing/centerSliceImage -name "flow_slice*.png" | sort -V | tail -n 1)
if [ -z "\$FLOW_IMAGE" ] || [ ! -f "\$FLOW_IMAGE" ]; then
  FLOW_IMAGE=\$(find . -name "flow_slice*.png" | sort -V | tail -n 1)
fi
if [ -n "\$FLOW_IMAGE" ] && [ -f "\$FLOW_IMAGE" ]; then
  echo "==> Found flow slice image: \$FLOW_IMAGE"
  aws s3 cp "\$FLOW_IMAGE" "s3://\$S3_BUCKET/results/\$JOB_ID/flow_slice.png" --content-type "image/png"
else
  echo "==> Flow slice image not found."
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

// 5. GET /api/jobs/:id/log: Stream simulation.log from S3
app.get('/api/jobs/:id/log', requireAuth, async (req, res) => {
  const jobId = req.params.id;
  const jobState = await getJobState(jobId);
  if (!jobState) {
    return res.status(404).json({ error: 'Job not found' });
  }
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
});

// 6. GET /api/jobs/:id/download: Redirect or download results.zip
app.get('/api/jobs/:id/download', requireAuth, async (req, res) => {
  const jobId = req.params.id;
  const jobState = await getJobState(jobId);
  if (!jobState) {
    return res.status(404).json({ error: 'Job not found' });
  }
  try {
    const getCommand = new GetObjectCommand({
      Bucket: bucketName,
      Key: `results/${jobId}/results.zip`
    });
    const url = await getSignedUrl(s3Client, getCommand, { expiresIn: 3600 });
    if (req.query.json === 'true') {
      res.json({ url });
    } else {
      res.redirect(url);
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate results download URL' });
  }
});

// 7. GET /api/jobs/:id/visualisation: Redirect or serve flow_slice.png
app.get('/api/jobs/:id/visualisation', requireAuth, async (req, res) => {
  const jobId = req.params.id;
  const jobState = await getJobState(jobId);
  if (!jobState) {
    return res.status(404).json({ error: 'Job not found' });
  }
  try {
    const getCommand = new GetObjectCommand({
      Bucket: bucketName,
      Key: `results/${jobId}/flow_slice.png`
    });
    const url = await getSignedUrl(s3Client, getCommand, { expiresIn: 3600 });
    if (req.query.json === 'true') {
      res.json({ url });
    } else {
      res.redirect(url);
    }
  } catch (err) {
    console.error("Failed to generate S3 URL for flow slice:", err);
    res.status(500).json({ error: 'Failed to generate visualisation download URL' });
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