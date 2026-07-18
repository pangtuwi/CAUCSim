# CAUCSim - F24 Aerodynamic CFD Toolkit

CAUCSim is a cloud-native, event-driven web application designed as the frontend interface for performing Computational Fluid Dynamics (CFD) aerodynamic simulations of Greenpower F24 vehicle designs.

The platform utilizes a modern serverless direct-to-storage architecture, bypassing backend payload bottlenecks by streaming binary CAD files directly from the browser to AWS S3.

---

## Key Features

### 1. 3D CAD Viewport
- **High-Visibility Rendering:** Visualizes vehicle geometries in a standard CAD **Z-up coordinate system** (with Z as the vertical axis and the X-axis extending along the vehicle's length).
- **Dynamic Headlight:** A camera-attached directional light follows orbit movements to guarantee visible surfaces are always clearly illuminated.
- **Custom 3D Axes:** Features a prominent 3D axes helper (Red = X, Green = Y, Blue = Z) positioned at the origin to easily reference coordinates.
- **Instant Client-Side Loading:** STL files are rendered immediately upon selection using in-memory blob references (`URL.createObjectURL`), bypassing initial upload wait times.

### 2. Aerodynamic Analytics
- **Projected Frontal Area:** Uses an optimized 2D grid rasterization algorithm on the Y-Z plane to compute the exact projected frontal area ($m^2$) of the vehicle in under 15ms.
- **CdA (Drag Area) Calculator:** Input an assumed Drag Coefficient ($C_d$) to instantly calculate the aerodynamic drag area ($CdA$).
- **F24 Regulations Checklist:** Automatically validates model length ($\le 2400$ mm) and width ($\le 900$ mm) constraints, as well as mesh watertightness/closure.

### 3. Serverless Storage Architecture (AWS S3)
- **Direct-to-S3 Uploads:** Eliminates `multer` and multipart/form parsing. The Express server generates cryptographically signed PUT/GET URLs via the `@aws-sdk/s3-request-presigner` and the client PUTs the binary payload directly to AWS S3.
- **Local Mock Fallback:** If S3 configurations are absent, the application seamlessly runs in a local disk fallback mode, simulating presigned storage flows.
- **Connection Status indicators:** The top bar header dynamically updates to display the connection status of the Local Server, CAD Storage (AWS S3 vs Local Mock, complete with S3 bucket tooltips), and the OpenFOAM Engine.

### 4. Authentication via AWS Cognito
- **Secure Sign In:** Protects sensitive CAD files and simulation endpoints. The frontend communicates directly with AWS Cognito User Pools (via HTTP fetch) to exchange credentials for ID tokens.
- **JWT Validation Middleware:** The Express server validates RS256 JWT signatures on all data requests using `aws-jwt-verify`.
- **Developer Bypass (Mock Mode):** If Cognito configuration is omitted, the app starts in a local developer mode, providing an overlay bypass button.
- **Setup Instructions:** Refer to [AUTHSETUP.md](file:///Users/paulwilliams/Documents/Programming/CAUCSim/Documentation/AUTHSETUP.md) for step-by-step AWS Cognito User Pool creation.

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
- Define `S3_BUCKET_NAME` and `AWS_REGION` in the Lambda Environment Variables console configuration.
