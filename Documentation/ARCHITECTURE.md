# Technical Architecture Document: Serverless CFD Orchestration Platform

This document outlines the cloud-native, event-driven architecture designed for the CAUC CFD (Computational Fluid Dynamics) simulation platform. The platform enables automated OpenFOAM simulation pipelines for aerodynamic analysis using a hybrid serverless/cloud-compute topography.

---

## 1. Architectural Blueprint & Data Flow

The platform relies on a decoupled, asynchronous, "scale-to-zero" model. Heavy payload processing entirely bypasses the stateless application server layer, utilizing direct-to-storage orchestration.

```
                  [ 1. Request Presigned PUT URL ]
       ┌───────────────────────────────────────────────────> [ AWS Lambda ]
       │                                                       │ (Node.js/Express)
       │          [ 2. Return Presigned PUT & GET ]            │
       │ <─────────────────────────────────────────────────────┘
       │
[ Client Browser ] ───[ 3. Stream CAD Binary Direct (PUT) ]──────────────┐
       │                                                                 │
       │                                                                 v
       │ ───[ 4. Initialize Simulation (Pass S3 Object Key) ]─> [ AWS Lambda ]
       │                                                                 │
       │                                                     (Provison Server Via API)
       │                                                                 v
       │ <──[ 6. Polling Status / Pull Light Metrics ]      [ DigitalOcean API ]
       │                                                                 │
       │                                                       (Spins Up Compute)
       │                                                                 v
       │                                                    [ Dedicated Droplet ]
       │                                                       (Ubuntu + OpenFOAM)
       │                                                                 │
       │          ┌───────────[ 5. Execute Run Pipeline ]────────────────┘
       │          │             - Pulls CAD via AWS CLI
       │          │             - Executes blockMesh/snappyHexMesh
       │          │             - Executes simpleFoam / paraFoam export
       │          │             - Pushes runtime telemetry & log streams
       │          v             - Self-destructs instance via API
       └─> [ AWS S3 Bucket ] <───────────────────────────────────────────┘
```

---

## 2. Core Components & Technical Stack

### A. Web Frontend (Client Layer)
*   **3D Visualizer:** Native WebGL built via **Three.js**. To maximize interface speed and prevent redundant networking, the uploaded asset is visualized immediately via an in-memory blob reference (`URL.createObjectURL(file)`) instead of waiting for a round-trip network request.
*   **Asset Ingestion:** Directly streams files using raw HTTP `PUT` streams against S3 signed vectors. Completely stripped of `multipart/form-data` parsing libraries (`multer` dependency eliminated).
*   **Monitoring UI:** Asynchronous client-side state machine utilizing declarative interval execution to query state flags from the persistent backend cache.

### B. Gateway & Application Server (Orchestration Layer)
*   **Runtime:** **Node.js with Express**, fully deployed as an **AWS Lambda Function**.
*   **Operational Footprint:** Stateless. Acts strictly as an execution controller, authentication gatekeeper, and metadata mapper.
*   **Responsibilities:**
    1. Cryptographically signing upload vectors (`@aws-sdk/s3-request-presigner`).
    2. Dispatching provisioning payloads to the infrastructural hypervisor.
    3. Serving historical asset indices and log telemetry interfaces.

### C. Storage Array (Persistence Layer)
*   **Platform Engine:** **AWS S3 (Simple Storage Service)**.
*   **Data Layout:**
    *   `uploads/` - Immutable source STL files named via custom collision-resistant hashes (e.g. `uploads/${Date.now()}_${filename}`).
    *   `results/` - Packaged simulation results organized per job ID:
        *   `job.json` - Persistent metadata file tracking simulation state, parameters, and parsed metrics (see schema below).
        *   `results.zip` - Compressed archive containing full OpenFOAM solver directories (`0/`, `constant/`, `system/`, `postProcessing/`, `simulation.log`).
        *   `simulation.log` - Full diagnostic output stream synced in real-time from the droplet's boot and execution sequences.
        *   `flow_slice.png` - Centerline velocity magnitude slice ($Y=0$ plane) rendered by a lightweight python plotter.
        *   `flow_streamlines_3d.png` - Static 3D streamtracer visualization thumbnail rendered via ParaView.
        *   `flow_3d_streamlines.gltf` - Interactive 3D streamlines model rendered as a self-contained GLTF containing inlined buffers.
        *   `forceCoeffs.dat` - Raw aerodynamic force coefficients output file.
*   **Security & Boundaries:** Configured with a dedicated **Cross-Origin Resource Sharing (CORS)** filter restricting verb propagation explicitly to the development environment (`localhost`) and production domains.

#### Schema of `results/<jobId>/job.json`
This metadata file acts as the single source of truth for the frontend state machine. It contains:
*   **Identification & Status:**
    *   `jobId` - Unique ID generated upon simulation request.
    *   `jobToken` - Secret authentication token used by the droplet to authorize state callbacks (removed from public API responses to the client browser).
    *   `status` - Active lifecycle state (`queued`, `running`, `completed`, `failed`).
    *   `stage` - Active execution stage (`initializing`, `mesh_generation`, `solving`, `processing_results`, `generating_visualisation`, `completed`).
*   **Job Parameters:**
    *   `fileKey` - S3 key for the uploaded STL geometry source file.
    *   `originalName` - The original user-visible filename of the geometry.
    *   `frontalArea` - Projected frontal area ($m^2$) computed automatically on the client during geometry analysis (`calculateFrontalArea`, a Y-Z plane rasterization) and submitted with the job. Not user-entered. Null if the value was unavailable or non-positive at submission.
    *   `raceSpeedMph` - User-selected race speed in miles per hour (persisted per job, defaults to 30 mph).
*   **Timestamps & Infrastructure:**
    *   `startedAt`, `updatedAt`, `completedAt` - ISO 8601 timestamps of job milestones.
    *   `dropletId` - The DigitalOcean droplet instance ID. Used by the server to query droplet health and detect orphaned runs.
    *   `error` - Diagnostic message string if the job status changes to `failed`.
*   **Metrics Payload:**
    *   `metrics` - Final compiled simulation outputs extracted from `forceCoeffs.dat` and augmented by the callback controller:
        *   `cd` / `cl` / `cm` - Standard aerodynamic drag, lift, and moment coefficients.
        *   `cda` / `cla` - Scaled aerodynamic area coefficients ($C_d \times A_{ref}$ and $C_l \times A_{ref}$).
        *   `aref` - Reference frontal area used during solving.
        *   `dragForce` - Total calculated aerodynamic drag force (Newtons) based on `raceSpeedMph`.
        *   `liftForce` - Total calculated aerodynamic lift/downforce (Newtons) based on `raceSpeedMph`.
        *   `aeroPower` - Calculated aerodynamic power consumption (Watts).

### D. Elastic Compute Node (HPC Processing Layer)
*   **Platform Engine:** **DigitalOcean Compute API** (Optimized Dedicated High-CPU Droplets, optimized for single-node matrix calculations).
*   **Image Management:** Custom pre-baked OS Snapshot containing a compiled snapshot of **OpenFOAM**, relevant mesh extraction tools (`snappyHexMesh`), automated execution wrappers, and (optionally) a headless **ParaView**/`pvpython` install used to render 3D streamline visuals — the droplet script detects `pvpython` at runtime and skips 3D rendering gracefully if it's absent from the snapshot.
*   **Lifecycle Controller:** **Cloud-Init (User Data bash payload)**. The instance boots, auto-configures its environment, checks out the data slice from S3, drives the execution loop, commits results back to S3, and explicitly signals the hypervisor to destroy its own hardware instance to prevent idle billing leaks.
*   **User-Selectable Race Speed & Dynamic Case Patching:** To maximize simulation accuracy, the case is dynamically configured at runtime on the droplet before meshing begins:
    1.  **Speed Conversion:** The user-selected `raceSpeedMph` (e.g. 30 mph) is retrieved from the request and converted to meters per second ($m/s$) ($1 \text{ mph} \approx 0.44704 \text{ m/s}$).
    2.  **Inlet Velocity Patching:** The inlet velocity in `0/include/initialConditions` is updated to the calculated $m/s$ velocity using a `sed` regex replacement:
        ```bash
        sed -i -E "s|flowVelocity[[:space:]]+\\(.*\\);|flowVelocity         (\$RACE_SPEED 0 0);|g" 0/include/initialConditions
        ```
    3.  **Turbulence Scaling:** The turbulence parameters (`turbulentKE` and `turbulentOmega` in `0/include/initialConditions`) are scaled relative to the template's reference speed (20 m/s) to keep the template's turbulence intensity constant:
        *   $k = 0.24 \times \left(\frac{U_{\infty}}{U_{\text{ref}}}\right)^2$
        *   $\omega = 1.78 \times \left(\frac{U_{\infty}}{U_{\text{ref}}}\right)$
    4.  **Reference Values for Forces:** The Reference Velocity (`magUInf`) in `system/forceCoeffs` is updated to match the converted race speed. If a computed frontal area was submitted with the job, `Aref` is updated in `system/forceCoeffs` as well; otherwise the case template's default `Aref` is left in place.
    5.  **Visualization Scale Synchronization:** To ensure readable visualization scales, the maximum velocity scale limit (`vmax` in `generate_slice.py` and `RescaleTransferFunction` in `render_flow.py`) is scaled according to the race speed to keep the visual scales matching the actual flow speed.

---

## 3. Key Implementation Specifications

### A. S3 Presigned URL Token Exchange (Express Interface)
```javascript
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const s3Client = new S3Client({ region: "eu-west-2" });

app.post('/api/get-upload-url', async (req, res) => {
    const { filename, fileType } = req.body;
    const uniqueKey = `uploads/${Date.now()}_${filename}`;

    const command = new PutObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: uniqueKey,
        ContentType: fileType
    });

    try {
        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
        res.json({ uploadUrl, fileKey: uniqueKey });
    } catch (err) {
        res.status(500).json({ error: "S3_SIGNING_FAILURE" });
    }
});
```

### B. Client-Side Upload Sequence
```javascript
async function uploadMeshFile(file) {
    // Phase 1: Retrieve tokenized signature window
    const signatureResponse = await fetch('/api/get-upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, fileType: file.type })
    });
    const { uploadUrl, fileKey } = await signatureResponse.json();

    // Phase 2: High-bandwidth stream straight to object storage
    const storageResponse = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file
    });

    if (!storageResponse.ok) throw new Error("OBJECT_STORAGE_STREAM_FAILED");
    return fileKey;
}
```

### C. Cloud-Init Compute Run Script (`user_data`)
```bash
#!/bin/bash
set -e
exec > >(tee -ia /var/log/cloud-init-output.log) 2>&1

JOB_ID="{{JOB_ID}}"
JOB_TOKEN="{{JOB_TOKEN}}"
CALLBACK_URL="{{CALLBACK_URL}}/api/jobs/{{JOB_ID}}/callback"
S3_BUCKET="{{S3_BUCKET}}"
STL_KEY="{{STL_KEY}}"
TEMPLATE_KEY="case-template.zip"
AWS_REGION="{{AWS_REGION}}"
FRONTAL_AREA="{{FRONTAL_AREA}}"
RACE_SPEED="{{RACE_SPEED}}"
TURB_KE="{{TURB_KE}}"
TURB_OMEGA="{{TURB_OMEGA}}"
VIS_SCALE_MAX="{{VIS_SCALE_MAX}}"

# Export AWS credentials immediately so all subshells/background loops inherit them
export AWS_ACCESS_KEY_ID="{{AWS_ACCESS_KEY_ID}}"
export AWS_SECRET_ACCESS_KEY="{{AWS_SECRET_ACCESS_KEY}}"
export AWS_DEFAULT_REGION="$AWS_REGION"

# Start background safety self-destruct timer (1 hour fallback to prevent runtime leaks)
(
  sleep 3600
  echo "==> [SAFETY TIMEOUT] 1 hour elapsed. Self-destructing..."
  DROPLET_ID=$(curl -s http://169.254.169.254/metadata/v1/id)
  curl -s -X DELETE \
       -H "Authorization: Bearer {{DIGITALOCEAN_TOKEN}}" \
       "https://api.digitalocean.com/v2/droplets/$DROPLET_ID"
) &

# Periodically push active log to S3 (every 5 seconds)
(
  while true; do
    if [ -f /root/cfd_run/simulation.log ]; then
      aws s3 cp /root/cfd_run/simulation.log "s3://$S3_BUCKET/results/$JOB_ID/simulation.log" --content-type "text/plain" --quiet || true
    elif [ -f /var/log/cloud-init-output.log ]; then
      aws s3 cp /var/log/cloud-init-output.log "s3://$S3_BUCKET/results/$JOB_ID/simulation.log" --content-type "text/plain" --quiet || true
    fi
    sleep 5
  done
) >/dev/null 2>&1 &
LOG_SYNC_PID=$!

# Helper function to update job state in S3 and callback URL
update_job_status() {
  local status="$1"
  local stage="$2"
  local error="$3"
  local metrics="$4"

  # Fetch current state to preserve other fields, or initialize template
  aws s3 cp "s3://$S3_BUCKET/results/$JOB_ID/job.json" current_job.json || echo '{"jobId":"'$JOB_ID'"}' > current_job.json

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
" "$status" "$stage" "$error" "$metrics"

  # Push updated state file back to S3
  aws s3 cp updated_job.json "s3://$S3_BUCKET/results/$JOB_ID/job.json" --content-type "application/json" || true

  # Execute callback to server
  curl -s -X POST "$CALLBACK_URL" \
       -H "Content-Type: application/json" \
       -H "X-Job-Token: $JOB_TOKEN" \
       -d @callback.json || true
}

# Ensure core packages and AWS CLI are installed
# (skips if already baked into pre-configured snapshot)
if ! command -v unzip >/dev/null 2>&1 || ! command -v zip >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1 || ! python3 -c "import numpy, matplotlib" >/dev/null 2>&1; then
  apt-get update && apt-get install -y unzip zip curl python3-numpy python3-matplotlib
fi

if ! command -v aws >/dev/null 2>&1; then
  curl -s "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
  unzip -q awscliv2.zip
  ./aws/install
  rm -rf awscliv2.zip aws/
fi

# Notify API Server: Droplet booted, starting setup
update_job_status "running" "initializing"

mkdir -p /root/cfd_run
cd /root/cfd_run

# Download case template and user STL file from S3
aws s3 cp "s3://$S3_BUCKET/$TEMPLATE_KEY" ./template.zip
unzip -o template.zip
rm template.zip

# ----------------- RUNTIME DYNAMIC PARAMETER PATCHING -----------------

# Update frontal area (Aref) in system/forceCoeffs if provided
if [ -n "$FRONTAL_AREA" ]; then
  sed -i -E "s|Aref[[:space:]]+[0-9.]+;|Aref            $FRONTAL_AREA;|g" system/forceCoeffs
fi

# Apply the user-selected race speed and turbulence scaling
sed -i -E "s|flowVelocity[[:space:]]+\\(.*\\);|flowVelocity         ($RACE_SPEED 0 0);|g" 0/include/initialConditions
sed -i -E "s|turbulentKE[[:space:]]+[0-9.]+;|turbulentKE          $TURB_KE;|g" 0/include/initialConditions
sed -i -E "s|turbulentOmega[[:space:]]+[0-9.]+;|turbulentOmega       $TURB_OMEGA;|g" 0/include/initialConditions
sed -i -E "s|magUInf[[:space:]]+[0-9.]+;|magUInf         $RACE_SPEED;|g" system/forceCoeffs

# Rescale visualization color scales
sed -i -E "s|vmax=[0-9.]+|vmax=$VIS_SCALE_MAX|g" generate_slice.py
sed -i -E "s|RescaleTransferFunction\\(0.0, [0-9.]+\\)|RescaleTransferFunction(0.0, $VIS_SCALE_MAX)|g" render_flow.py

# Adjust Allrun script for solver phase triggers
sed -i '1s|#!/bin/sh|#!/bin/bash|' Allrun
sed -i '/==> potentialFoam/i update_job_status "running" "solving"' Allrun

# Stage the model geometry
mkdir -p constant/geometry
aws s3 cp "s3://$S3_BUCKET/$STL_KEY" constant/geometry/Basic_F24.stl

# ----------------- EXECUTE CFD SIMULATION -----------------

# Notify API Server: Starting meshing
update_job_status "running" "mesh_generation"

# Load OpenFOAM environment
export OMPI_ALLOW_RUN_AS_ROOT=1
export OMPI_ALLOW_RUN_AS_ROOT_CONFIRM=1
set +e
source /opt/openfoam13/etc/bashrc
set -e

# Export helper function so children (Allrun) can access them
export -f update_job_status
export JOB_ID JOB_TOKEN CALLBACK_URL S3_BUCKET

# Run execution pipeline
chmod +x Allrun
./Allrun > simulation.log 2>&1 || {
  aws s3 cp simulation.log "s3://$S3_BUCKET/results/$JOB_ID/simulation.log"
  update_job_status "failed" "solving" "OpenFOAM execution failed"
  kill $LOG_SYNC_PID || true

  DROPLET_ID=$(curl -s http://169.254.169.254/metadata/v1/id)
  curl -s -X DELETE \
       -H "Authorization: Bearer {{DIGITALOCEAN_TOKEN}}" \
       "https://api.digitalocean.com/v2/droplets/$DROPLET_ID"
  exit 1
}

# ----------------- PROCESS & UPLOAD RESULTS -----------------

update_job_status "running" "processing_results"

# Compress results (excluding processor directories to save space)
zip -r results.zip 0/ constant/ system/ postProcessing/ simulation.log -x "processor*" || true

# Upload results back to S3
aws s3 cp results.zip "s3://$S3_BUCKET/results/$JOB_ID/results.zip"
aws s3 cp simulation.log "s3://$S3_BUCKET/results/$JOB_ID/simulation.log"
if [ -f postProcessing/forceCoeffs/0/forceCoeffs.dat ]; then
  aws s3 cp postProcessing/forceCoeffs/0/forceCoeffs.dat "s3://$S3_BUCKET/results/$JOB_ID/forceCoeffs.dat"
fi

# Generate 2D flow slice image
VTK_FILE=$(find postProcessing/cutPlane -name "yNormal.vtk" | sort -V | tail -n 1)
if [ -n "$VTK_FILE" ] && [ -f "$VTK_FILE" ]; then
  python3 generate_slice.py "$VTK_FILE" flow_slice.png || true
fi

FLOW_IMAGE=$(find postProcessing/centerSliceImage -name "flow_slice*.png" | sort -V | tail -n 1)
if [ -z "$FLOW_IMAGE" ] || [ ! -f "$FLOW_IMAGE" ]; then
  FLOW_IMAGE=$(find . -name "flow_slice*.png" | sort -V | tail -n 1)
fi
if [ -n "$FLOW_IMAGE" ] && [ -f "$FLOW_IMAGE" ]; then
  aws s3 cp "$FLOW_IMAGE" "s3://$S3_BUCKET/results/$JOB_ID/flow_slice.png" --content-type "image/png"
fi

# Generate 3D streamlines visualization (PNG + GLTF)
TRACKS_FILE=$(find postProcessing/streamlines -name "*.vtp" 2>/dev/null | sort -V | tail -n 1)
if [ -z "$TRACKS_FILE" ]; then
  TRACKS_FILE=$(find postProcessing/streamlines -name "*.vtk" 2>/dev/null | sort -V | tail -n 1)
fi
if [ -n "$TRACKS_FILE" ] && [ -f "$TRACKS_FILE" ] && command -v pvpython >/dev/null 2>&1 && command -v xvfb-run >/dev/null 2>&1; then
  update_job_status "running" "generating_visualisation"
  timeout 300 xvfb-run -a --server-args='-screen 0 1280x1024x24' pvpython render_flow.py "$TRACKS_FILE" "." || true
  if [ -f flow_streamlines_3d.png ]; then
    aws s3 cp flow_streamlines_3d.png "s3://$S3_BUCKET/results/$JOB_ID/flow_streamlines_3d.png" --content-type "image/png" || true
  fi
  if [ -f flow_3d_streamlines.gltf ]; then
    aws s3 cp flow_3d_streamlines.gltf "s3://$S3_BUCKET/results/$JOB_ID/flow_3d_streamlines.gltf" --content-type "model/gltf+json" || true
  fi
fi

# Calculate force coefficients and compile aerodynamic metrics
METRICS_JSON="{}"
COEFFS_FILE="postProcessing/forceCoeffs/0/forceCoeffs.dat"
if [ -f "$COEFFS_FILE" ]; then
  METRICS_JSON=$(python3 - <<EOF
import json
try:
    with open("$COEFFS_FILE", "r") as f:
        lines = [line.strip() for line in f if line.strip() and not line.startswith("#")]
    if lines:
        last_line = lines[-1].split()
        time = float(last_line[0])
        cm = float(last_line[1])
        cd = float(last_line[2])
        cl = float(last_line[3])

        aref = 1.0
        with open("$COEFFS_FILE", "r") as f:
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
update_job_status "completed" "completed" "" "$METRICS_JSON"

kill $LOG_SYNC_PID || true

# Hard Self-Destruct to stop billing
DROPLET_ID=$(curl -s http://169.254.169.254/metadata/v1/id)
curl -s -X DELETE \
     -H "Authorization: Bearer {{DIGITALOCEAN_TOKEN}}" \
     "https://api.digitalocean.com/v2/droplets/$DROPLET_ID"
```

---

## 4. Antigravity AI Prompt Context Guidelines

When passing this framework into your AI coding assistant, enforce compliance with these three paradigms:
1. **Never Re-introduce Local Form Parsers:** All multi-part code, body-parsers tracking binary nodes, or temporary local file locks inside the Node.js process framework are strictly banned.
2. **Stateless Operations:** Route handlers must process requests as isolated events. Ensure state vectors (such as simulation status tracking) are either queried out of an explicit state log cache (e.g., lightweight JSON state buffers on S3 or DynamoDB keys) or derived cleanly from external events.
3. **Fail-Safe Self-Destruct Routines:** Compute provisioning blocks inside Node.js must explicitly register error paths or hard shell exits within the Cloud-Init script block to prevent zombie droplets from accumulating runtime charges under execution faults. Additionally, an asynchronous background safety timer (e.g. `sleep 3600` followed by a DO delete request) should be spawned on boot inside the droplet's User Data to serve as a hard, automatic self-destruct cutoff (typically 1 hour) in case of system hang or API callback failure.
