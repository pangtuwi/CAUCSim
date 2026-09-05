// Conditionally load dotenv for local development (skipped in production/Lambda)
// .env lives at the repo root, two levels above this file
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
}

const express = require('express');
const serverless = require('serverless-http');
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();
const port = process.env.PORT || 3000;

// Enable JSON body parsing for API requests
app.use(express.json());

// Disable caching for all API endpoints
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// Detect if running in AWS Lambda vs local machine
const isLambda = !!process.env.LAMBDA_TASK_ROOT;

// Serve frontend static assets with cache-busting headers
app.use(express.static(path.join(__dirname, '../../frontend/cfd'), {
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

const MPH_TO_MS = 0.44704;
const DEFAULT_RACE_SPEED_MPH = 30;
// Inlet velocity the OpenFOAM case template ships with; turbulence and
// visualisation scales in the template are calibrated against it.
const TEMPLATE_REF_SPEED_MS = 20;

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
    if (err.message && err.message.includes('expired')) {
      console.log(`JWT Verification: Token expired (${err.message})`);
    } else {
      console.error("JWT Verification failed:", err.message);
    }
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

  const normalizedFileKey = path.posix.normalize(fileKey);

  if (!normalizedFileKey.startsWith('uploads/') || normalizedFileKey === 'uploads/') {
    return res.status(400).json({ error: 'Invalid file key' });
  }

  try {
    const deleteCommand = new DeleteObjectCommand({
      Bucket: bucketName,
      Key: normalizedFileKey
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
  const { fileKey, frontalArea, raceSpeedMph, wheelbase, momentCentreX, fastCheck } = req.body;
  if (!fileKey) {
    return res.status(400).json({ error: 'fileKey is required' });
  }

  const cleanFileKey = fileKey.replace(/[^a-zA-Z0-9./_-]/g, '_');
  const jobId = `job-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const jobToken = crypto.randomBytes(16).toString('hex');
  const originalName = fileKey.substring(fileKey.indexOf('_') + 1);
  const cleanFrontalArea = typeof frontalArea === 'number' && !isNaN(frontalArea) && frontalArea > 0 ? frontalArea : null;
  const cleanRaceSpeedMph = typeof raceSpeedMph === 'number' && !isNaN(raceSpeedMph) && raceSpeedMph > 0
    ? Math.min(100, raceSpeedMph)
    : DEFAULT_RACE_SPEED_MPH;
  const raceSpeedMs = cleanRaceSpeedMph * MPH_TO_MS;
  // Wheelbase (m) normalises Cm; the moment centre is the point Cm is taken
  // about. Both are left null when absent so the template keeps its own value.
  const cleanWheelbase = typeof wheelbase === 'number' && isFinite(wheelbase) && wheelbase > 0 ? wheelbase : null;
  const cleanMomentCentreX = typeof momentCentreX === 'number' && isFinite(momentCentreX) ? momentCentreX : null;
  // Strict boolean: anything else means full fidelity, so a malformed request
  // can never silently downgrade a run to the coarse mesh.
  const cleanFastCheck = fastCheck === true;

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
    metrics: null,
    frontalArea: cleanFrontalArea,
    raceSpeedMph: cleanRaceSpeedMph,
    wheelbase: cleanWheelbase,
    momentCentreX: cleanMomentCentreX,
    fastCheck: cleanFastCheck
  };

  try {
    await saveJobState(jobId, initialJobState);

    const doToken = process.env.DIGITALOCEAN_TOKEN;
    if (!doToken) {
      return res.status(400).json({ error: 'DigitalOcean credentials are not configured on the server. Cannot run CFD simulation.' });
    }
    // Deliberately no default: an unset value used to fall back to a
    // hard-coded name, which silently booted a stale image (one without
    // ParaView) and produced jobs that "succeeded" while missing their 3D
    // streamlines artifacts. Fail loudly instead.
    const doSnapshotName = process.env.DIGITALOCEAN_SNAPSHOT_NAME;
    if (!doSnapshotName && !process.env.DIGITALOCEAN_IMAGE_ID) {
      return res.status(400).json({
        error: 'DIGITALOCEAN_SNAPSHOT_NAME is not configured on the server. Set it (or pin DIGITALOCEAN_IMAGE_ID) before running a CFD simulation.'
      });
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
    let sessionTokenLine = '';
    if (process.env.AWS_SESSION_TOKEN) {
      sessionTokenLine = `export AWS_SESSION_TOKEN="${process.env.AWS_SESSION_TOKEN}"`;
    }
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
FRONTAL_AREA="${cleanFrontalArea !== null ? cleanFrontalArea : ''}"
WHEELBASE="${cleanWheelbase !== null ? cleanWheelbase.toFixed(4) : ''}"
MOMENT_CENTRE_X="${cleanMomentCentreX !== null ? cleanMomentCentreX.toFixed(4) : ''}"
FAST_CHECK="${cleanFastCheck ? '1' : ''}"
RACE_SPEED="${raceSpeedMs.toFixed(4)}"
TURB_KE="${(0.24 * Math.pow(raceSpeedMs / TEMPLATE_REF_SPEED_MS, 2)).toFixed(5)}"
TURB_OMEGA="${(1.78 * (raceSpeedMs / TEMPLATE_REF_SPEED_MS)).toFixed(5)}"
VIS_SCALE_MAX="${(Math.ceil((raceSpeedMs * 1.5) / 5) * 5).toFixed(1)}"

# Export AWS credentials immediately so all subshells/background loops inherit them
export AWS_ACCESS_KEY_ID="${process.env.AWS_ACCESS_KEY_ID || ''}"
export AWS_SECRET_ACCESS_KEY="${process.env.AWS_SECRET_ACCESS_KEY || ''}"
${sessionTokenLine}
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
import json, sys, time
status = sys.argv[1]
stage = sys.argv[2]
error = sys.argv[3]
metrics_str = sys.argv[4]

try:
    with open('current_job.json', 'r') as f:
        data = json.load(f)
except Exception:
    data = {}

data['status'] = status
data['stage'] = stage
data['updatedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())

if error:
    data['error'] = error
else:
    data.pop('error', None)

if metrics_str:
    try:
        data['metrics'] = json.loads(metrics_str)
    except Exception as e:
        data['error'] = 'Failed to parse metrics: ' + str(e)

with open('updated_job.json', 'w') as f:
    json.dump(data, f, indent=2)

# Generate callback payload
callback_data = {'status': status, 'stage': stage}
if error:
    callback_data['error'] = error
if metrics_str:
    try:
        callback_data['metrics'] = json.loads(metrics_str)
    except Exception:
        pass

with open('callback.json', 'w') as f:
    json.dump(callback_data, f)
" "\$status" "\$stage" "\$error" "\$metrics"

  # Push updated state file back to S3
  aws s3 cp updated_job.json "s3://\$S3_BUCKET/results/\$JOB_ID/job.json" --content-type "application/json" || true
  
  # Execute fallback callback to local server (if accessible)
  curl -s -X POST "\$CALLBACK_URL" \\
       -H "Content-Type: application/json" \\
       -H "X-Job-Token: \$JOB_TOKEN" \\
       -d @callback.json || true
}

# Install zip, unzip, curl, numpy, and matplotlib -- skipped if already
# baked into the snapshot (see Documentation/SETUP_DROPLET.md), falls back
# to installing them here so a stale/bare snapshot still works.
if ! command -v unzip >/dev/null 2>&1 || ! command -v zip >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1 || ! python3 -c "import numpy, matplotlib" >/dev/null 2>&1; then
  echo "==> Installing system packages..."
  apt-get update && apt-get install -y unzip zip curl python3-numpy python3-matplotlib
else
  echo "==> System packages already present on snapshot, skipping install."
fi

# Install official AWS CLI v2 -- skipped if already baked into the snapshot
if ! command -v aws >/dev/null 2>&1; then
  echo "==> Installing AWS CLI v2..."
  curl -s "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
  unzip -q awscliv2.zip
  ./aws/install
  rm -rf awscliv2.zip aws/
else
  echo "==> AWS CLI already present on snapshot, skipping install."
fi

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

# Update frontal area (Aref) in system/forceCoeffs if provided
if [ -n "$FRONTAL_AREA" ]; then
  echo "==> Updating Aref in system/forceCoeffs to $FRONTAL_AREA..."
  sed -i -E "s|Aref[[:space:]]+[0-9.]+;|Aref            \$FRONTAL_AREA;|g" system/forceCoeffs
fi

# Update the reference length (lRef) used to normalise Cm. Left alone when the
# client sent no wheelbase, so the template's own fallback stands.
if [ -n "$WHEELBASE" ]; then
  echo "==> Updating lRef in system/forceCoeffs to $WHEELBASE..."
  sed -i -E "s|lRef[[:space:]]+[0-9.]+;|lRef            \$WHEELBASE;|g" system/forceCoeffs
fi

# Update the moment centre (CofR) that Cm is taken about: the model's
# mid-length on the ground plane, matching the template's convention.
if [ -n "$MOMENT_CENTRE_X" ]; then
  echo "==> Updating CofR in system/forceCoeffs to ($MOMENT_CENTRE_X 0 0)..."
  sed -i -E "s|CofR[[:space:]]+\\([^)]*\\);|CofR            (\$MOMENT_CENTRE_X 0 0);|g" system/forceCoeffs
fi

# Fast check: patch the case back down to a coarse mesh and a short run. This
# is a deliberately inaccurate sanity check, not a result - the convergence
# test on the reported coefficients will (correctly) fail for these runs.
if [ "$FAST_CHECK" = "1" ]; then
  echo "==> FAST CHECK MODE: coarse mesh and 50 iterations - results are NOT accurate."
  sed -i -E "s|endTime[[:space:]]+500;|endTime         50;|g" system/controlDict
  sed -i -E "s|writeInterval[[:space:]]+100;|writeInterval   50;|g" system/controlDict
  sed -i -E "s|level \\(5 6\\);|level (3 4);|g" system/snappyHexMeshDict
  sed -i -E "s|level[[:space:]]+4;|level   2;|g" system/snappyHexMeshDict
  sed -i -E "s|\\(40 16 16\\)|(20 8 8)|g" system/blockMeshDict
fi

# Apply the user-selected race speed to the inlet, the force-coefficient
# reference velocity, and the turbulence inlet values (scaled to keep the
# template's turbulence intensity constant).
echo "==> Setting race speed to \$RACE_SPEED m/s..."
sed -i -E "s|flowVelocity[[:space:]]+\\(.*\\);|flowVelocity         (\$RACE_SPEED 0 0);|g" 0/include/initialConditions
sed -i -E "s|turbulentKE[[:space:]]+[0-9.]+;|turbulentKE          \$TURB_KE;|g" 0/include/initialConditions
sed -i -E "s|turbulentOmega[[:space:]]+[0-9.]+;|turbulentOmega       \$TURB_OMEGA;|g" 0/include/initialConditions
sed -i -E "s|magUInf[[:space:]]+[0-9.]+;|magUInf         \$RACE_SPEED;|g" system/forceCoeffs

# Keep the visualisation colour scales in step with the inlet velocity
sed -i -E "s|vmax=[0-9.]+|vmax=\$VIS_SCALE_MAX|g" generate_slice.py
sed -i -E "s|RescaleTransferFunction\\(0.0, [0-9.]+\\)|RescaleTransferFunction(0.0, \$VIS_SCALE_MAX)|g" render_flow.py

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

# Generate flow slice image from VTK using python script
echo "==> Generating flow slice image from VTK..."
VTK_FILE=\$(find postProcessing/cutPlane -name "yNormal.vtk" | sort -V | tail -n 1)
if [ -n "\$VTK_FILE" ] && [ -f "\$VTK_FILE" ]; then
  echo "==> Found VTK file for plotting: \$VTK_FILE"
  python3 generate_slice.py "\$VTK_FILE" flow_slice.png || echo "==> Failed to run python plotter."
else
  echo "==> yNormal.vtk not found."
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

# Generate 3D streamlines visualisation (PNG + GLB) from the OpenFOAM
# streamlines function object's track output, using headless ParaView
echo "==> Locating OpenFOAM streamline tracks for 3D visualisation..."
TRACKS_FILE=\$(find postProcessing/streamlines -name "*.vtp" 2>/dev/null | sort -V | tail -n 1)
if [ -z "\$TRACKS_FILE" ]; then
  TRACKS_FILE=\$(find postProcessing/streamlines -name "*.vtk" 2>/dev/null | sort -V | tail -n 1)
fi
if [ -n "\$TRACKS_FILE" ] && [ -f "\$TRACKS_FILE" ] && command -v pvpython >/dev/null 2>&1 && command -v xvfb-run >/dev/null 2>&1; then
  echo "==> Found streamline tracks: \$TRACKS_FILE. Running pvpython render_flow.py..."
  update_job_status "running" "generating_visualisation"
  # pvpython (apt ParaView) needs an X display -- xvfb-run supplies a virtual
  # one. The explicit screen size matters: xvfb-run's bare defaults aren't
  # enough, ParaView's vtkXOpenGLRenderWindow aborts with "bad X server
  # connection" against them (see Documentation/SETUP_DROPLET.md).
  timeout 300 xvfb-run -a --server-args='-screen 0 1280x1024x24' pvpython render_flow.py "\$TRACKS_FILE" "." || echo "==> pvpython 3D visualisation failed or timed out; continuing without it."
  if [ -f flow_streamlines_3d.png ]; then
    aws s3 cp flow_streamlines_3d.png "s3://\$S3_BUCKET/results/\$JOB_ID/flow_streamlines_3d.png" --content-type "image/png" || true
  fi
  if [ -f flow_3d_streamlines.gltf ]; then
    aws s3 cp flow_3d_streamlines.gltf "s3://\$S3_BUCKET/results/\$JOB_ID/flow_3d_streamlines.gltf" --content-type "model/gltf+json" || true
  fi
else
  echo "==> Skipping 3D visualisation (no streamline tracks found, or pvpython/xvfb-run unavailable)."
fi

# The API server derives the reported coefficients from the forceCoeffs.dat
# uploaded above, so the droplet does no post-processing of its own.
# Notify API Server: Finished!
update_job_status "completed" "completed"

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

  // Derive the coefficients here if the callback never managed it. The droplet
  // writes job.json to S3 directly and only then curls the callback with
  // "|| true", so a callback that never arrives (a job started against a
  // different APP_CALLBACK_URL, a transient network failure) must not cost the
  // user their results. Derived values are cached back into the job state.
  if (jobState.status === 'completed' && !jobState.metrics && !jobState.metricsChecked) {
    const derived = await computeMetricsFromResults(jobId, jobState);
    if (derived.metrics) {
      jobState.metrics = applyDerivedForces(derived.metrics, jobState);
      jobState.metricsError = null;
    } else {
      jobState.metricsError = derived.error;
    }
    // Only worth one attempt: a missing force history will not appear later.
    jobState.metricsChecked = true;
    stateChanged = true;
  }

  if (stateChanged) {
    await saveJobState(jobId, jobState);
  }

  const clientState = { ...jobState };
  delete clientState.jobToken;
  res.json(clientState);
});

// --- Force-coefficient reporting -------------------------------------------

// Trailing iterations averaged for the reported value, and the shorter windows
// used to test whether that average has stopped drifting.
const COEFF_SAMPLE_WINDOW = 200;
const COEFF_CHECK_WINDOWS = [100, 150, 200];
// A window-to-window drift below this is indistinguishable from the flow's own
// oscillation, so it counts as settled.
const COEFF_DRIFT_ABS = 0.002;
const COEFF_DRIFT_REL = 0.01;

function meanOf(values) {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stdDevOf(values, mean) {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Reduce an OpenFOAM forceCoeffs.dat history to the coefficients we report.
 *
 * A steady RANS solve of a bluff body never settles on a single number: real
 * vortex shedding leaves a persistent oscillation even once converged. Reading
 * the final iteration therefore reports one arbitrary point on that
 * oscillation, and cannot tell a converged run from one still trending. So
 * average a trailing window instead, and judge convergence by whether that
 * average is insensitive to how long the window is - drift between windows is
 * the signal, the oscillation within them is not.
 *
 * Returns null when the file yields no usable rows.
 */
function computeCoefficientStatistics(fileContents) {
  if (typeof fileContents !== 'string') return null;

  const rows = [];
  let aref = null;

  for (const rawLine of fileContents.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      // The header carries the Aref the solve actually used, which is the one
      // CdA/ClA must be built from.
      const match = line.match(/^#\s*Aref\s*[:=]?\s*(-?[0-9.eE+-]+)/);
      if (match) {
        const parsed = parseFloat(match[1]);
        if (isFinite(parsed)) aref = parsed;
      }
      continue;
    }

    // Columns: time, Cm, Cd, Cl - the order the previous reader assumed.
    const fields = line.split(/\s+/);
    if (fields.length < 4) continue;
    const cm = parseFloat(fields[1]);
    const cd = parseFloat(fields[2]);
    const cl = parseFloat(fields[3]);
    if (!isFinite(cm) || !isFinite(cd) || !isFinite(cl)) continue;
    rows.push({ cm, cd, cl });
  }

  if (rows.length === 0) return null;

  const tail = (n) => rows.slice(Math.max(0, rows.length - n));
  const sample = tail(Math.min(COEFF_SAMPLE_WINDOW, rows.length));

  const cdValues = sample.map((r) => r.cd);
  const clValues = sample.map((r) => r.cl);
  const cmValues = sample.map((r) => r.cm);
  const cd = meanOf(cdValues);
  const cl = meanOf(clValues);
  const cm = meanOf(cmValues);

  // Clamp each check window to the data available. A short run collapses them
  // all onto the same rows, leaving nothing to compare - which is itself the
  // answer: convergence has not been demonstrated.
  const windowSizes = [...new Set(COEFF_CHECK_WINDOWS.map((n) => Math.min(n, rows.length)))];
  let converged = false;
  if (windowSizes.length > 1) {
    converged = ['cd', 'cl'].every((key) => {
      const windowMeans = windowSizes.map((n) => meanOf(tail(n).map((r) => r[key])));
      const drift = Math.max(...windowMeans) - Math.min(...windowMeans);
      const overallMean = key === 'cd' ? cd : cl;
      const tolerance = Math.max(COEFF_DRIFT_ABS, COEFF_DRIFT_REL * Math.abs(overallMean));
      return drift <= tolerance;
    });
  }

  return {
    cd,
    cl,
    cm,
    cdStd: stdDevOf(cdValues, cd),
    clStd: stdDevOf(clValues, cl),
    cmStd: stdDevOf(cmValues, cm),
    converged,
    sampleCount: sample.length,
    iterations: rows.length,
    aref
  };
}

// Turn the dimensionless coefficients into the forces and power shown in the
// results panel, at the speed this job was actually solved at.
function applyDerivedForces(metrics, jobState) {
  if (metrics.cda) {
    const raceSpeed = (jobState.raceSpeedMph || DEFAULT_RACE_SPEED_MPH) * MPH_TO_MS;
    metrics.dragForce = parseFloat((0.5 * 1.225 * Math.pow(raceSpeed, 2) * metrics.cda).toFixed(1));
    if (metrics.cla) {
      metrics.liftForce = parseFloat((0.5 * 1.225 * Math.pow(raceSpeed, 2) * metrics.cla).toFixed(1));
    }
    metrics.aeroPower = parseFloat((metrics.dragForce * raceSpeed).toFixed(0));
  }
  return metrics;
}

// Build the reported metrics from the forceCoeffs.dat the droplet uploaded
// before it called back. Returns null if the file is missing or unusable, in
// which case the caller keeps whatever the droplet sent.
async function computeMetricsFromResults(jobId, jobState) {
  const key = `results/${jobId}/forceCoeffs.dat`;
  let contents;

  try {
    const response = await s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
    contents = await response.Body.transformToString();
  } catch (err) {
    // Most likely the solver never wrote postProcessing/forceCoeffs/0/forceCoeffs.dat,
    // so the droplet had nothing to upload.
    console.error(`[${jobId}] Could not read ${key}: ${err.name || 'error'} - ${err.message}`);
    return { error: `The solver's force history could not be read (${err.name || 'S3 error'}). Check the run log.` };
  }

  const stats = computeCoefficientStatistics(contents);
  if (!stats) {
    console.error(`[${jobId}] ${key} held no usable rows (${contents.length} bytes).`);
    return { error: 'The solver produced no usable force history. Check the run log.' };
  }

  {
    const round = (v) => parseFloat(v.toFixed(6));
    const metrics = {
      cd: round(stats.cd),
      cl: round(stats.cl),
      cm: round(stats.cm),
      cdStd: round(stats.cdStd),
      clStd: round(stats.clStd),
      cmStd: round(stats.cmStd),
      converged: stats.converged,
      sampleCount: stats.sampleCount,
      iterations: stats.iterations,
      fastCheck: jobState.fastCheck === true
    };

    // Prefer the Aref the solve actually recorded over the one the client sent.
    const aref = stats.aref !== null ? stats.aref : jobState.frontalArea;
    if (typeof aref === 'number' && isFinite(aref) && aref > 0) {
      metrics.aref = aref;
      metrics.cda = round(stats.cd * aref);
      metrics.cla = round(stats.cl * aref);
    }
    return { metrics };
  }
}

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

  // The droplet uploads forceCoeffs.dat before it reports completion, so the
  // coefficients are derived here rather than on the droplet - that keeps the
  // convergence statistics in testable JS.
  let resolvedMetrics = metrics;
  if (status === 'completed') {
    const derived = await computeMetricsFromResults(jobId, jobState);
    if (derived.metrics) {
      resolvedMetrics = derived.metrics;
      jobState.metricsError = null;
    } else {
      // Record why, so the results panel can say something useful instead of
      // just rendering empty.
      jobState.metricsError = derived.error;
    }
  }

  if (resolvedMetrics) {
    jobState.metrics = applyDerivedForces(resolvedMetrics, jobState);
    jobState.metricsChecked = true;
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
    // Check if flow slice image exists in S3
    const headCommand = new HeadObjectCommand({
      Bucket: bucketName,
      Key: `results/${jobId}/flow_slice.png`
    });
    await s3Client.send(headCommand);

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
    if (err.name === 'NotFound' || err.name === 'NoSuchKey' || err.code === 'NoSuchKey') {
      return res.status(404).json({ error: 'Visualisation image not found on S3' });
    }
    console.error("Failed to generate S3 URL for flow slice:", err);
    res.status(500).json({ error: 'Failed to generate visualisation download URL' });
  }
});

// 8. GET /api/jobs/:id/streamlines-image: Redirect or serve flow_streamlines_3d.png
app.get('/api/jobs/:id/streamlines-image', requireAuth, async (req, res) => {
  const jobId = req.params.id;
  const jobState = await getJobState(jobId);
  if (!jobState) {
    return res.status(404).json({ error: 'Job not found' });
  }
  try {
    const headCommand = new HeadObjectCommand({
      Bucket: bucketName,
      Key: `results/${jobId}/flow_streamlines_3d.png`
    });
    await s3Client.send(headCommand);

    const getCommand = new GetObjectCommand({
      Bucket: bucketName,
      Key: `results/${jobId}/flow_streamlines_3d.png`
    });
    const url = await getSignedUrl(s3Client, getCommand, { expiresIn: 3600 });
    if (req.query.json === 'true') {
      res.json({ url });
    } else {
      res.redirect(url);
    }
  } catch (err) {
    if (err.name === 'NotFound' || err.name === 'NoSuchKey' || err.code === 'NoSuchKey') {
      return res.status(404).json({ error: 'Streamlines image not found on S3' });
    }
    console.error("Failed to generate S3 URL for streamlines image:", err);
    res.status(500).json({ error: 'Failed to generate streamlines image download URL' });
  }
});

// 9. GET /api/jobs/:id/streamlines-model: Redirect or serve flow_3d_streamlines.gltf
app.get('/api/jobs/:id/streamlines-model', requireAuth, async (req, res) => {
  const jobId = req.params.id;
  const jobState = await getJobState(jobId);
  if (!jobState) {
    return res.status(404).json({ error: 'Job not found' });
  }
  try {
    const headCommand = new HeadObjectCommand({
      Bucket: bucketName,
      Key: `results/${jobId}/flow_3d_streamlines.gltf`
    });
    await s3Client.send(headCommand);

    const getCommand = new GetObjectCommand({
      Bucket: bucketName,
      Key: `results/${jobId}/flow_3d_streamlines.gltf`
    });
    const url = await getSignedUrl(s3Client, getCommand, { expiresIn: 3600 });
    if (req.query.json === 'true') {
      res.json({ url });
    } else {
      res.redirect(url);
    }
  } catch (err) {
    if (err.name === 'NotFound' || err.name === 'NoSuchKey' || err.code === 'NoSuchKey') {
      return res.status(404).json({ error: 'Streamlines model not found on S3' });
    }
    console.error("Failed to generate S3 URL for streamlines model:", err);
    res.status(500).json({ error: 'Failed to generate streamlines model download URL' });
  }
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}

module.exports = app;
module.exports.computeCoefficientStatistics = computeCoefficientStatistics;
module.exports.handler = serverless(app, {
  binary: ['image/*', 'application/zip', 'application/octet-stream']
});