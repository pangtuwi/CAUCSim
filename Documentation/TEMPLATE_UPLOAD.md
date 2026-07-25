# Case Template Upload Guide - CAUCSim

This document describes how to update and upload the OpenFOAM case template to AWS S3. 

The application utilizes a zipped template (`case-template.zip`) stored in the S3 bucket to initialize the simulation directory on freshly provisioned DigitalOcean compute droplets. When a user runs a simulation, the droplet downloads this template, places the uploaded STL file into the environment, runs the mesh generation, and solves the CFD simulation.

---

## 1. Directory Structure

The source directory for the OpenFOAM template is located at `/openfoam-template` in the root of the project. It contains the standard directory structure required for an OpenFOAM simulation:

*   **`0/`**: Initial and boundary condition files (e.g., velocity `U`, pressure `p`, turbulence parameters like `k`, `omega`, `nut`).
*   **`constant/`**: Physical properties, transport/turbulence models, and the `triSurface/` subdirectory where the vehicle STL models are injected for meshing.
*   **`system/`**: Mesh settings and control parameters (`controlDict`, `fvSchemes`, `fvSolution`, `blockMeshDict`, `snappyHexMeshDict`, `meshQualityDict`).
*   **`Allrun`**: The main execution shell script executed by the DigitalOcean droplet to run the meshers (`blockMesh`, `snappyHexMesh`) and the solver (`simpleFoam`).
*   **`Allclean`**: Cleanup script to purge previous mesh configurations and solver outputs.
*   **`Allrun_local`**: Executable helper to test the simulation workflow locally (if OpenFOAM is installed on the host system).

---

## 2. Prerequisites for Uploading

Before running the upload command, make sure your environment is properly configured.

### A. Environment Configuration (`.env`)
The upload script reads credentials and configuration parameters from the `.env` file located at the root of the project. Ensure the following variables are configured:

1.  **`S3_BUCKET_NAME`**: The name of the target AWS S3 bucket. (e.g., `cauc-cfd-storage-bucket-247638741223-eu-west-2-an`).
2.  **`AWS_REGION`**: The target region where your S3 bucket resides (defaults to `eu-west-2` if not specified).

### B. AWS Credentials
To upload to S3, your environment must have permission to write to the configured S3 bucket. The AWS SDK automatically searches the following locations for credentials:
1.  **`.env` File (Development Bypass/Local Testing)**: Set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` directly.
2.  **AWS Shared Credentials File**: Typically located at `~/.aws/credentials` (configured via `aws configure`).
3.  **Environment Variables**: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optional `AWS_SESSION_TOKEN`.

### C. System Tools
*   **Node.js**: The script runs on Node.js.
*   **`zip` Command Line Tool**: The script runs `zip -r` as a shell command. This is pre-installed on macOS and Linux systems.

---

## 3. Step-by-Step Instructions

To upload an updated case template:

### Step 1: Modify the OpenFOAM files
Make the required configuration changes within the [openfoam-template](file:///Users/paulwilliams/Documents/Programming/CAUCSim/openfoam-template) folder. Common modifications include:
*   Adjusting solver convergence criteria in [system/fvSolution](file:///Users/paulwilliams/Documents/Programming/CAUCSim/openfoam-template/system/fvSolution).
*   Changing time step size or simulation length in [system/controlDict](file:///Users/paulwilliams/Documents/Programming/CAUCSim/openfoam-template/system/controlDict).
*   Updating background mesh resolution in [system/blockMeshDict](file:///Users/paulwilliams/Documents/Programming/CAUCSim/openfoam-template/system/blockMeshDict) or snappy refinement parameters in [system/snappyHexMeshDict](file:///Users/paulwilliams/Documents/Programming/CAUCSim/openfoam-template/system/snappyHexMeshDict).
*   Editing the droplet execution flow in the [Allrun](file:///Users/paulwilliams/Documents/Programming/CAUCSim/openfoam-template/Allrun) script.

### Step 2: Run the upload command
Open a terminal in the root of the project and execute the pre-configured npm script:
```bash
npm run upload-template
```
Alternatively, you can run the script directly:
```bash
node scripts/upload-template.js
```

### Step 3: Verify the output
The script will perform the following actions:
1.  Verify the environment has a defined `S3_BUCKET_NAME`.
2.  Navigate to the `openfoam-template` directory and compress its contents into a temporary root-level `case-template.zip`.
3.  Stream the zip file to the target S3 bucket under the key `case-template.zip`.
4.  Delete the local temporary `case-template.zip` file.

A successful execution will output:
```text
Zipping openfoam-template to /path/to/CAUCSim/case-template.zip...
  adding: Allrun (deflated 52%)
  adding: Allclean (deflated 44%)
  ...
Uploading /path/to/CAUCSim/case-template.zip to S3 bucket [bucket-name] as case-template.zip...
SUCCESS: Uploaded case-template.zip to S3!
Cleaning up local zip file...
```

If the upload fails, verify your S3 Bucket Name in `.env` and check that your AWS credentials have write (`s3:PutObject`) permissions on that bucket (see [AWSCONFIG.md](file:///Users/paulwilliams/Documents/Programming/CAUCSim/Documentation/AWSCONFIG.md)).

---

## 4. Under the Hood

The upload process is governed by the script at [upload-template.js](file:///Users/paulwilliams/Documents/Programming/CAUCSim/scripts/upload-template.js). 

Key details of the script behavior:
*   **Working Directory Independence**: It resolves absolute file paths relative to `__dirname`, meaning it can be run safely from any directory in your terminal.
*   **Compression Scope**: The zip is created by stepping into the `openfoam-template` folder and executing `zip -r ... .`. This ensures the structure within the archive is root-relative (e.g. `system/controlDict` is at the root of the zip file, rather than inside a nested `openfoam-template` folder). This root-relative structure is expected by the worker droplets' setup scripts.
*   **Cleanup Guarantee**: The `finally` block ensures that the temporary `case-template.zip` is always deleted from local disk even if the S3 upload encounters an error.
