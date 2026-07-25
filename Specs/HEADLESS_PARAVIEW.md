# Specification: Headless ParaView (`pvpython`) Automation for OpenFOAM Visualization

## 1. Overview
This specification details the headless execution of ParaView via `pvpython` on a DigitalOcean cloud compute instance running an OpenFOAM simulation. 

The objective is to process solved OpenFOAM case data, generate static high-resolution field visualizations (2D slices and 3D streamlines), and export an interactive **3D GLTF scene (`.gltf` / `.glb`)** alongside standard PNG renders prior to instance teardown. The resulting files are uploaded directly to AWS S3 for visualization on the frontend web application (e.g., Three.js viewer).

---

## 2. Requirements & Environment

### Technical Stack
* **OS:** Linux (Ubuntu 22.04 LTS or OpenFOAM pre-configured environment)
* **CFD Engine:** OpenFOAM (v2006+ / v10+)
* **Visualization Engine:** ParaView / `pvpython` (Python 3.x binding)
* **Output Artifacts:**
  * `flow_velocity_slice.png` (Static centerline slice)
  * `flow_3d_streamlines.gltf` / `.glb` (3D web-ready scene containing streamtracers colored by velocity field $U$)
  * `surface_pressure.png` (Pressure map on car surface)

### System Constraints
* **Headless Rendering:** Must run without an active X11 display. Mesa / EGL offscreen rendering drivers must be utilized by `pvpython`.
* **Execution Boundary:** Executed via Cloud-Init or post-processing bash script immediately following solver completion and prior to droplet termination.

---

## 3. Data Pipeline Architecture

┌────────────────────────┐      ┌──────────────────────────┐      ┌─────────────────────────┐
│ OpenFOAM Simulation    │ ───> │ Headless ParaView        │ ───> │ AWS S3 Storage Bucket   │
│ (Solves & writes mesh) │      │ (pvpython render_flow.py)│      │ (cad-uploads / results) │
└────────────────────────┘      └──────────────────────────┘      └─────────────────────────┘
│
├──> Exports static *.png
└──> Exports interactive *.gltf


---

## 4. Automation Script (`render_flow.py`)

Create a script named `render_flow.py` in the case root or system scripts folder.

```python
#!/usr/bin/env pvpython
# ==============================================================================
# Script: render_flow.py
# Description: Headless OpenFOAM post-processing script for ParaView (pvpython).
# Outputs: Static PNG images and 3D GLTF models for browser visualization.
# ==============================================================================

import os
import sys
from paraview.simple import *

# ------------------------------------------------------------------------------
# 1. Initialization and Setup
# ------------------------------------------------------------------------------
# Disable automatic render updates during pipeline construction
GetRenderView().EnableRenderOnSubmit = 0

# Set up offscreen render view
view = CreateRenderView()
view.ViewSize = [1920, 1080]
view.Background = [0.1, 0.1, 0.15]  # Dark background for web visualizers
view.OrientationAxesVisibility = 0

# Ensure dummy case file exists for OpenFOAM reader
case_dir = os.getcwd()
foam_file = os.path.join(case_dir, "case.foam")
if not os.path.exists(foam_file):
    with open(foam_file, "w") as f:
        f.write("")

# ------------------------------------------------------------------------------
# 2. Load OpenFOAM Case Data
# ------------------------------------------------------------------------------
print("[INFO] Loading OpenFOAM case data...")
reader = OpenFOAMReader(FileName=foam_file)
reader.MeshRegions = ['internalMesh']
reader.CellArrays = ['U', 'p']  # Load Velocity (U) and Pressure (p)

# Update pipeline to fetch available time steps and select final state
reader.UpdatePipeline()
time_values = reader.TimestepValues
if time_values:
    latest_time = time_values[-1]
    print(f"[INFO] Evaluating latest timestep: {latest_time}")
    view.ViewTime = latest_time

# ------------------------------------------------------------------------------
# 3. Create Centerline Velocity Slice (2D PNG Export)
# ------------------------------------------------------------------------------
print("[INFO] Generating centerline velocity slice...")
slice_filter = Slice(Input=reader)
slice_filter.SliceType = 'Plane'
slice_filter.SliceType.Origin = [0.0, 0.0, 0.0]
slice_filter.SliceType.Normal = [0.0, 1.0, 0.0]  # Cut along Y-axis (centerline)

slice_display = Show(slice_filter, view)
ColorBy(slice_display, ('CELLS', 'U', 'Magnitude'))

# Rescale color palette
u_lut = GetColorTransferFunction('U')
u_lut.ApplyPreset('Rainbow Desaturated', True)
u_lut.RescaleTransferFunction(0.0, 30.0)  # 0 to 30 m/s scale

# Camera position for side-profile screenshot
view.CameraPosition = [1.5, -5.0, 0.2]
view.CameraFocalPoint = [1.5, 0.0, 0.2]
view.CameraViewUp = [0.0, 0.0, 1.0]
view.CameraParallelProjection = 1
view.ResetCamera()

Render()
SaveScreenshot(os.path.join(case_dir, 'flow_velocity_slice.png'), view)
Hide(slice_filter, view)

# ------------------------------------------------------------------------------
# 4. Generate 3D Streamlines (U Field)
# ------------------------------------------------------------------------------
print("[INFO] Tracing 3D Streamlines...")
streamtracer = StreamTracer(Input=reader, SeedType='High Density Line Source')
streamtracer.Vectors = ['CELLS', 'U']

# Define seed line profile upstream of car profile
streamtracer.SeedType.Point1 = [-1.0, -0.8, 0.0]
streamtracer.SeedType.Point2 = [-1.0, 0.8, 0.8]
streamtracer.SeedType.Resolution = 100
streamtracer.MaximumStreamlineLength = 10.0

# Add tube thickness to streamlines for solid 3D mesh representation
tubes = Tube(Input=streamtracer)
tubes.Radius = 0.008
tubes.NumberOfSides = 6

tube_display = Show(tubes, view)
ColorBy(tube_display, ('POINT_DATA', 'U', 'Magnitude'))
tube_display.LookupTable = u_lut

# Reset Camera for 3D isometric view
view.CameraParallelProjection = 0
view.CameraPosition = [-2.5, -3.5, 2.0]
view.CameraFocalPoint = [1.0, 0.0, 0.3]
view.CameraViewUp = [0.0, 0.0, 1.0]
Render()

# Save static isometric screenshot
SaveScreenshot(os.path.join(case_dir, 'flow_streamlines_3d.png'), view)

# ------------------------------------------------------------------------------
# 5. Export 3D Web Model (GLTF / GLB Format)
# ------------------------------------------------------------------------------
gltf_output_path = os.path.join(case_dir, 'flow_3d_streamlines.gltf')
print(f"[INFO] Exporting 3D scene to GLTF: {gltf_output_path}")

# ExportView handles conversion of rendered VTK geometry/colors into GLTF 2.0 format
ExportView(gltf_output_path, view=view)

print("[SUCCESS] Headless ParaView processing complete.")
5. Integration into Droplet Teardown Pipeline
Integrate execution into the Droplet startup/teardown bash script (e.g., user_data / Cloud-Init execution script):

Bash
#!/bin/bash
set -e

# Case working directory
CASE_DIR="/home/ubuntu/cauc_cfd_case"
cd $CASE_DIR

# 1. Run OpenFOAM solver
simpleFoam > log.simpleFoam

# 2. Run pvpython post-processing script
pvpython render_flow.py

# 3. Synchronize generated visualization assets to S3
JOB_ID="job-$(date +%s)"
S3_TARGET_BUCKET="s3://cauc-cfd-storage-bucket/simulation-results/${JOB_ID}"

aws s3 cp flow_velocity_slice.png "${S3_TARGET_BUCKET}/flow_velocity_slice.png"
aws s3 cp flow_streamlines_3d.png "${S3_TARGET_BUCKET}/flow_streamlines_3d.png"
aws s3 cp flow_3d_streamlines.gltf "${S3_TARGET_BUCKET}/flow_3d_streamlines.gltf"
aws s3 cp flow_3d_streamlines.bin "${S3_TARGET_BUCKET}/flow_3d_streamlines.bin" || true

# 4. Notify API Gateway / Lambda job completion endpoint
curl -X POST [https://api.yourdomain.org.uk/jobs/$](https://api.yourdomain.org.uk/jobs/$){JOB_ID}/complete \
  -H "Content-Type: application/json" \
  -d '{"status": "COMPLETED", "gltfKey": "'${JOB_ID}'/flow_3d_streamlines.gltf"}'

# 5. Self-destruct droplet via DigitalOcean API
DROPLET_ID=$(curl -s [http://169.254.169.254/metadata/v1/id](http://169.254.169.254/metadata/v1/id))
curl -X DELETE -H "Authorization: Bearer $DO_API_TOKEN" \
  "[https://api.digitalocean.com/v2/droplets/$](https://api.digitalocean.com/v2/droplets/$){DROPLET_ID}"
6. Frontend Loading Pattern (Three.js Example)
To display the exported .gltf streamline mesh alongside the car STL in the browser client:

JavaScript
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const loader = new GLTFLoader();

// Fetch presigned S3 GET URL from Express API for GLTF model
const presignedGltfUrl = await fetchPresignedUrl('flow_3d_streamlines.gltf');

loader.load(presignedGltfUrl, (gltf) => {
    const streamlineScene = gltf.scene;
    scene.add(streamlineScene);
}, undefined, (error) => {
    console.error('Error loading 3D flow visualizer scene:', error);
});