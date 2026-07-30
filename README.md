# CAUCSim - F24 Aerodynamic CFD Toolkit

CAUCSim is a cloud-native, event-driven web application designed as the frontend interface for performing Computational Fluid Dynamics (CFD) aerodynamic simulations of Greenpower F24 vehicle designs.

The platform utilizes a modern serverless direct-to-storage architecture, bypassing backend payload bottlenecks by streaming binary CAD files directly from the browser to AWS S3.

---

## Key Features

### 1. 3D CAD Viewport
- **High-Visibility Rendering:** Visualizes vehicle geometries in a standard CAD **Z-up coordinate system** (with Z as the vertical axis and the X-axis extending along the vehicle's length).
- **Dynamic Headlight:** A camera-attached directional light follows orbit movements to guarantee visible surfaces are always clearly illuminated.
- **Custom 3D Axes:** Features a prominent 3D axes helper (Red = X, Green = Y, Blue = Z) positioned at the origin to easily reference coordinates.
- **Instant Client-Side Loading & State Reset:** STL files are rendered immediately upon selection using in-memory blob references (`URL.createObjectURL`). If a different model is loaded, the app automatically clears any active CFD polling and results states to avoid stale simulation overlays.
- **Unit Selector Defaulting:** Model unit selector defaults to **Meters (m)** to align directly with CFD simulation requirements.
- **Sequential Stage Gating:** The four workflow stages unlock in order rather than all at once. Loading a model opens **Geometry Check**, and the **CFD Simulation** stage only becomes available once the user has actually opened Geometry Check — so the regulations checklist is seen before a simulation can be launched. Each stage carries a one-line instruction, and its right-hand panel shows a placeholder (rather than an empty frame) until it has something to display. Resuming an in-flight job after a page reload bypasses the gating and returns directly to the running stage.

### 2. Aerodynamic Analytics
- **User-Selectable Race Speed:** The target race speed is set in Stage 3 before launching the simulation (in **mph**, defaulting to 30 mph, and shown alongside its **m/s** equivalent throughout the interface). The chosen speed is applied to the OpenFOAM inlet velocity, the force-coefficient reference velocity (`magUInf`), and the turbulence inlet values (`k` and `omega` are scaled so the case template's turbulence intensity is preserved), and it drives the drag/lift/power figures, the velocity axis on the performance charts, and the flow visualisation colour scales. Results remain labelled with the speed their run was actually solved at, so changing the input does not relabel a completed run.
- **Persistent Model View with Stacked Results:** The centre panel always shows the interactive 3D car model, with streamlines rendered directly onto it, so the geometry never disappears behind a results page. The numeric results and 2D visualisations (aerodynamic forces graph, power demand graph, and centreline flow slice) live as vertically stacked sub-panels in the right-hand **Aerodynamic Summary** column, which scrolls independently.
- **Projected Frontal Area:** Uses an optimized 2D grid rasterization algorithm on the Y-Z plane to compute the exact projected frontal area ($m^2$) of the vehicle in under 15ms.
- **F24 Regulations Checklist:** Automatically validates model length (&le; 2400 mm), width (&le; 900 mm), and height (&le; 1200 mm) constraints, mesh watertightness, proper $X$ coordinate positioning ($[0, \text{Length}]$), $Y$-axis symmetry, and $Z$-axis ground placement (wheels touching or slightly below $Z=0$).
- **CFD Metric Scale Check:** Validates model dimensions and flags warnings if coordinates suggest a millimeter-to-meter scaling mismatch, preventing OpenFOAM solver divergence.
- **Centerline Flow Visualisation:** Displays a centerline velocity magnitude slice (\(Y = 0\) plane), rendered by a lightweight Python/`matplotlib` script (`generate_slice.py`) that parses the raw OpenFOAM `cutPlane` VTK output on the droplet, avoiding the need for a headless ParaView/Mesa rendering stack for this 2D view.
- **3D Streamlines Visualisation:** Renders an isometric 3D streamtracer scene (colored by velocity magnitude) from the OpenFOAM `streamlines` function object's track output, using ParaView (`pvpython`) run headlessly via `xvfb-run` on the droplet. Produces both a static PNG thumbnail and an interactive GLTF model (buffers inlined as base64, single self-contained file). The GLTF loads directly into the main Three.js viewport and is shown on the car geometry automatically as soon as a run completes, with a toolbar icon to hide it and inspect the bare model; the static PNG is retained in the results bundle but is no longer surfaced separately in the UI, since streamlines are only ever viewed on the model. Requires `pvpython` and `xvfb-run` to be pre-installed on the DigitalOcean droplet snapshot (see [SETUP_DROPLET.md](file:///Users/paulwilliams/Documents/Programming/CAUCSim/Documentation/SETUP_DROPLET.md)); the step is skipped gracefully (without failing the job) if either is unavailable. Verified working end-to-end on a real droplet run.

### 3. Serverless Storage Architecture (AWS S3)
- **Direct-to-S3 Uploads:** Eliminates `multer` and multipart/form parsing. The Express server generates cryptographically signed PUT/GET URLs via the `@aws-sdk/s3-request-presigner` and the client PUTs the binary payload directly to AWS S3.
- **Dynamic Connection Status Indicators:** The header bar dynamically updates to show connection states for CAD Storage (complete with S3 bucket name tooltips) and the **OpenFOAM Engine** (which transitions between `Standby`, `Queued`, `Initializing`, `Meshing`, `Solving`, and `Processing` in real time).

### 4. Authentication via AWS Cognito
- **Secure Sign In:** Protects sensitive CAD files and simulation endpoints. The frontend communicates directly with AWS Cognito User Pools (via HTTP fetch) to exchange credentials for ID tokens.
- **JWT Validation Middleware:** The Express server validates RS256 JWT signatures on all data requests using `aws-jwt-verify`.
- **Setup Instructions:** Refer to [AUTHSETUP.md](file:///Users/paulwilliams/Documents/Programming/CAUCSim/Documentation/AUTHSETUP.md) for step-by-step AWS Cognito User Pool creation.

### 5. Elastic Cloud HPC Compute (DigitalOcean)
- **Scale-to-Zero HPC Droplets:** Launches high-performance dedicated compute droplets (`gd-16vcpu-64gb`) on-demand from a pre-configured OpenFOAM image snapshot using the DigitalOcean API.
- **Harmless Warning Suppression:** Wraps droplet environment setup in `set +e` and `set -e` to prevent non-critical shell warnings (e.g. bash context `pop_var_context` from `/opt/openfoam13/etc/bashrc` on Ubuntu 24.04) from aborting the boot sequence.
- **Runtime Case Patching:** The droplet script rewrites the extracted case in place (frontal area `Aref`, inlet velocity, `magUInf`, turbulence inlet values, and the visualisation colour scales) before meshing begins, so per-run parameters take effect without rebuilding or re-uploading the S3 case template.
- **Real-Time Solver Triggers:** Dynamically patches the droplet's `Allrun` script shebang to bash and inserts callback notification hooks right before `potentialFoam` and `foamRun` solver phases start.
- **Fail-Safe Droplet Self-Destruct:** Spawns an asynchronous 1-hour background sleep process on the droplet at boot, utilizing token interpolation for authorization. Even if the simulation hangs, runs into shell errors, or loses network connection, the droplet is guaranteed to destroy itself after exactly 1 hour to prevent runaway billing leaks.
- **Direct S3 Data Ingestion:** Droplets download the case-template and STL file directly from S3, perform meshing (`blockMesh`/`snappyHexMesh`), solve aerodynamic forces, generate and upload the `flow_slice.png` centerline visualisation and (when `pvpython` is available) the `flow_streamlines_3d.png` / `flow_3d_streamlines.gltf` 3D streamlines assets alongside the resulting `results.zip` / `simulation.log`, and immediately self-destruct.
- **Independent Log Scrolling & Viewport Capping:** Constrains Stage 3 panel heights and utilizes deferred browser layout rendering (`setTimeout`) so that the terminal auto-scrolls to the bottom cleanly without pushing its scrollbar off-screen on smaller laptops. The live monitor is laid out as a flex column so the execution log expands to fill the panel instead of collapsing to its minimum height.
- **Post-Run Log Viewer:** Stage 3's live console is replaced by the results panels once a run finishes, so Stage 4 carries a **View Log** action that re-fetches the completed run's full solver output from `/api/jobs/:id/log` into a large scrollable overlay. It opens at the top of the log (a finished record to read, rather than a live tail), dismisses via the close button, backdrop click, or `Escape`, and closes automatically when the run is cleared.

---

## Getting Started

### 1. Installation
Clone the repository and install the dependencies:
```bash
npm install
```

### 2. Environment Configuration
Create a `.env` file in the root directory (based on `.env.example`):
```env
# AWS S3 Configuration
S3_BUCKET_NAME=your-cauc-cfd-bucket
AWS_REGION=eu-west-2

# AWS Credentials (Required for local S3 testing; omit when deploying to Lambda)
AWS_ACCESS_KEY_ID=your_access_key_id
AWS_SECRET_ACCESS_KEY=your_secret_access_key

# AWS Cognito Configuration
COGNITO_USER_POOL_ID=your_user_pool_id
COGNITO_CLIENT_ID=your_app_client_id
```

### 3. Run Locally
Start the development server with watch mode enabled:
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your web browser.

---

## Production Security (AWS Lambda)
When deploying the Express application as a serverless Lambda:
- Do not pack your `.env` file containing credentials.
- Assign an **IAM Execution Role** to the Lambda function containing read/write permissions for your S3 bucket. The AWS SDK will automatically assume this role to request S3 credentials securely.
- Define `S3_BUCKET_NAME`, `AWS_REGION`, and the DigitalOcean configuration keys (`DIGITALOCEAN_TOKEN`, `DIGITALOCEAN_PROJECT_ID`, etc.) as **GitHub Secrets** when deploying via GitHub Actions, or configure them directly in the AWS Lambda Environment Variables console. These are mapped in `serverless.yaml` and `.github/workflows/deploy.yml` to automate their injection during deployment.
- **`DIGITALOCEAN_SNAPSHOT_NAME` is required and has no default.** Job creation returns an error if neither it nor `DIGITALOCEAN_IMAGE_ID` is set, rather than falling back to a hard-coded snapshot name. Keep this value in step with the snapshot you actually want booted — pointing it at an image that predates the ParaView install produces jobs that complete normally but silently omit the 3D streamlines artifacts, since that step is skipped gracefully when `pvpython`/`xvfb-run` are missing.

---

## Documentation Index

For detailed technical specifications and setup guides, refer to:
*   [ARCHITECTURE.md](file:///Users/paulwilliams/Documents/Programming/CAUCSim/Documentation/ARCHITECTURE.md) - Overview of the system topography, decoupled architecture, and client-side data flows.
*   [AUTHSETUP.md](file:///Users/paulwilliams/Documents/Programming/CAUCSim/Documentation/AUTHSETUP.md) - Detailed step-by-step instructions for establishing AWS Cognito User Pools.
*   [AWSCONFIG.md](file:///Users/paulwilliams/Documents/Programming/CAUCSim/Documentation/AWSCONFIG.md) - Reference record of production AWS resource naming and permission schemas.
*   [TEMPLATE_UPLOAD.md](file:///Users/paulwilliams/Documents/Programming/CAUCSim/Documentation/TEMPLATE_UPLOAD.md) - Step-by-step instructions for modifying and uploading updated OpenFOAM case templates to S3.
*   [SETUP_DROPLET.md](file:///Users/paulwilliams/Documents/Programming/CAUCSim/Documentation/SETUP_DROPLET.md) - How to build and update the pre-baked DigitalOcean snapshot (OpenFOAM + headless ParaView) that CFD droplets boot from.
