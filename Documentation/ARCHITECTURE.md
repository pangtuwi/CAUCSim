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
    *   `uploads/` - Immutable source files named via custom collision-resistant hashes (`uploads/${Date.now()}_${filename}`).
    *   `results/` - Packaged post-processed fields, normalized slice visuals (PNGs), structural metadata JSON packages, and simulation logs (`simulation.log`).
*   **Security & Boundaries:** Configured with a dedicated **Cross-Origin Resource Sharing (CORS)** filter restricting verb propagation explicitly to the development environment (`localhost`) and production domains.

### D. Elastic Compute Node (HPC Processing Layer)
*   **Platform Engine:** **DigitalOcean Compute API** (Optimized Dedicated High-CPU Droplets, optimized for single-node matrix calculations).
*   **Image Management:** Custom pre-baked OS Snapshot containing a compiled snapshot of **OpenFOAM**, relevant mesh extraction tools (`snappyHexMesh`), and automated execution wrappers.
*   **Lifecycle Controller:** **Cloud-Init (User Data bash payload)**. The instance boots, auto-configures its environment, checks out the data slice from S3, drives the execution loop, commits results back to S3, and explicitly signals the hypervisor to destroy its own hardware instance to prevent idle billing leaks.

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

# System Setup
apt-get update && apt-get install -y awscli curl

# Pipeline Initialization
JOB_ID="{{JOB_ID}}"
FILE_KEY="{{FILE_KEY}}"
S3_BUCKET="s3://your-cauc-cfd-bucket"

# Notify API Server: Run Loop Initiated
curl -X POST https://api.yourdomain.com/jobs/$JOB_ID/status \
     -H "Content-Type: application/json" \
     -d '{"status": "running", "stage": "mesh_generation"}'

# Stage Source Code / CAD Asset
mkdir -p /opt/cfd_run
aws s3 cp $S3_BUCKET/$FILE_KEY /opt/cfd_run/case.stl

# Run OpenFOAM Pipeline Vector
cd /opt/cfd_run
./run_openfoam_pipeline.sh > simulation.log 2>&1

# Export and Push Structural Data Array
aws s3 cp /opt/cfd_run/results/ $S3_BUCKET/results/$JOB_ID/ --recursive
aws s3 cp simulation.log $S3_BUCKET/results/$JOB_ID/

# Notify API Server: Completion Verification
curl -X POST https://api.yourdomain.com/jobs/$JOB_ID/status \
     -H "Content-Type: application/json" \
     -d '{"status": "completed"}'

# Hard Self-Destruct to Zero Out Operational Expenses
DROPLET_ID=$(curl -s http://169.254.169.254/metadata/v1/id)
curl -X DELETE \
     -H "Authorization: Bearer {{DIGITALOCEAN_TOKEN}}" \
     "https://api.digitalocean.com/v2/droplets/$DROPLET_ID"
```

---

## 4. Antigravity AI Prompt Context Guidelines

When passing this framework into your AI coding assistant, enforce compliance with these three paradigms:
1. **Never Re-introduce Local Form Parsers:** All multi-part code, body-parsers tracking binary nodes, or temporary local file locks inside the Node.js process framework are strictly banned.
2. **Stateless Operations:** Route handlers must process requests as isolated events. Ensure state vectors (such as simulation status tracking) are either queried out of an explicit state log cache (e.g., lightweight JSON state buffers on S3 or DynamoDB keys) or derived cleanly from external events.
3. **Fail-Safe Self-Destruct Routines:** Compute provisioning blocks inside Node.js must explicitly register error paths or hard shell exits within the Cloud-Init script block to prevent zombie droplets from accumulating runtime charges under execution faults.
