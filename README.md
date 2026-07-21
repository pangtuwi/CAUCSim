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

### 2. Aerodynamic Analytics
- **Projected Frontal Area:** Uses an optimized 2D grid rasterization algorithm on the Y-Z plane to compute the exact projected frontal area ($m^2$) of the vehicle in under 15ms.
- **CdA (Drag Area) Calculator:** Input an assumed Drag Coefficient ($C_d$) to instantly calculate the aerodynamic drag area ($CdA$).
- **F24 Regulations Checklist:** Automatically validates model length ($\le 2400$ mm) and width ($\le 900$ mm) constraints, as well as mesh watertightness/closure.
- **CFD Metric Scale Check:** Validates model dimensions and flags warnings if coordinates suggest a millimeter-to-meter scaling mismatch, preventing OpenFOAM solver divergence.
- **Centerline Flow Visualisation:** Displays a centerline velocity magnitude slice (\(Y = 0\) plane) rendered directly by OpenFOAM's `runTimePostProcessing` VTK/Mesa function object at the end of the simulation.

### 3. Serverless Storage Architecture (AWS S3)
- **Direct-to-S3 Uploads:** Eliminates `multer` and multipart/form parsing. The Express server generates cryptographically signed PUT/GET URLs via the `@aws-sdk/s3-request-presigner` and the client PUTs the binary payload directly to AWS S3.
- **Local Mock Fallback:** If S3 configurations are absent, the application seamlessly runs in a local disk fallback mode, simulating presigned storage flows.
- **Dynamic Connection Status Indicators:** The header bar dynamically updates to show connection states for the Local Server, CAD Storage (complete with S3 bucket name tooltips), and the **OpenFOAM Engine** (which transitions between `Standby`, `Queued`, `Initializing`, `Meshing`, `Solving`, and `Processing` in real time).

### 4. Authentication via AWS Cognito
- **Secure Sign In:** Protects sensitive CAD files and simulation endpoints. The frontend communicates directly with AWS Cognito User Pools (via HTTP fetch) to exchange credentials for ID tokens.
- **JWT Validation Middleware:** The Express server validates RS256 JWT signatures on all data requests using `aws-jwt-verify`.
- **Developer Bypass (Mock Mode):** If Cognito configuration is omitted, the app starts in a local developer mode, providing an overlay bypass button.
- **Setup Instructions:** Refer to [AUTHSETUP.md](file:///Users/paulwilliams/Documents/Programming/CAUCSim/Documentation/AUTHSETUP.md) for step-by-step AWS Cognito User Pool creation.

### 5. Elastic Cloud HPC Compute (DigitalOcean)
- **Scale-to-Zero HPC Droplets:** Launches high-performance dedicated compute droplets (`gd-16vcpu-64gb`) on-demand from a pre-configured OpenFOAM image snapshot using the DigitalOcean API.
- **Harmless Warning Suppression:** Wraps droplet environment setup in `set +e` and `set -e` to prevent non-critical shell warnings (e.g. bash context `pop_var_context` from `/opt/openfoam13/etc/bashrc` on Ubuntu 24.04) from aborting the boot sequence.
- **Real-Time Solver Triggers:** Dynamically patches the droplet's `Allrun` script shebang to bash and inserts callback notification hooks right before `potentialFoam` and `foamRun` solver phases start.
- **Fail-Safe Droplet Self-Destruct:** Spawns an asynchronous 1-hour background sleep process on the droplet at boot, utilizing token interpolation for authorization. Even if the simulation hangs, runs into shell errors, or loses network connection, the droplet is guaranteed to destroy itself after exactly 1 hour to prevent runaway billing leaks.
- **Direct S3 Data Ingestion:** Droplets download the case-template and STL file directly from S3, perform meshing (`blockMesh`/`snappyHexMesh`), solve aerodynamic forces, upload the resulting `results.zip` / `simulation.log`, and immediately self-destruct.
- **Independent Log Scrolling & Viewport Capping:** Constrains Stage 3 panel heights and utilizes deferred browser layout rendering (`setTimeout`) so that the terminal auto-scrolls to the bottom cleanly without pushing its scrollbar off-screen on smaller laptops.

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

# AWS Cognito Configuration (Omit to use Mock Bypass Login mode)
COGNITO_USER_POOL_ID=your_user_pool_id
COGNITO_CLIENT_ID=your_app_client_id
```
*Note: If `S3_BUCKET_NAME` or `COGNITO_USER_POOL_ID` are left blank, the app will automatically fall back to **Local Disk Mock Mode** and **Mock Authentication Bypass Mode**.*

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
