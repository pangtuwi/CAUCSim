#!/usr/bin/env pvpython
# ==============================================================================
# Script: render_pressure.py
# Description: Headless ParaView (pvpython) post-processing script that
#              colors the car body surface (patch f24, exported by
#              `foamToVTK -fields '(p)' -noInternal`, then filtered by
#              filename for the f24 patch) by pressure coefficient Cp, and
#              exports an interactive GLTF scene for the CAUCSim Three.js
#              viewer, plus a small JSON sidecar recording the Cp range for
#              the frontend legend.
# ==============================================================================

import json
import os
import sys

from paraview.simple import *

# Fixed Cp color-scale bounds, chosen to match the range CAUCSim's own
# ParaView-based review has used for this car (roughly stagnation to
# suction-peak) so the legend stays comparable run-to-run.
CP_COLOR_RANGE = (-1.1, 1.1)


def main():
    if len(sys.argv) < 4:
        print("Usage: pvpython render_pressure.py <patch_surface_file> <output_dir> <uinf_mps>")
        sys.exit(1)

    surface_path = sys.argv[1]
    output_dir = sys.argv[2]
    uinf = float(sys.argv[3])

    if not os.path.exists(surface_path):
        print(f"Error: {surface_path} does not exist")
        sys.exit(1)

    print(f"[INFO] Loading car surface pressure data from {surface_path}...")
    reader = OpenDataFile(surface_path)
    reader.UpdatePipeline()

    # foamToVTK on a patch typically writes cell data, not point data (unlike
    # the cutPlane/streamlines function objects, which explicitly interpolate
    # to points) -- glTF only supports per-vertex colors, so this is a
    # required step whenever the source data is cell-centred, and a no-op
    # otherwise.
    to_point_data = CellDatatoPointData(Input=reader)
    to_point_data.UpdatePipeline()

    # Cp = (p - p_ref) / (0.5 * rho * Uinf^2); rho=1 and p_ref=0 gauge
    # pressure, matching the incompressible convention already used in
    # system/forceCoeffs (rhoInf 1).
    calc = Calculator(Input=to_point_data)
    calc.ResultArrayName = 'Cp'
    calc.Function = f'p / (0.5*1*{uinf}*{uinf})'
    calc.UpdatePipeline()

    # snappyHexMesh's surface-snapped f24 patch doesn't always come out with
    # consistent triangle winding, which makes some faces invisible from
    # outside once loaded single-sided in the Three.js viewer -- those spots
    # read as transparent holes that show whatever is behind them (often the
    # inside of the car). Recomputing normals with consistent, outward
    # orientation fixes the winding so every face renders from the outside.
    normals = GenerateSurfaceNormals(Input=calc)
    # Exposed GenerateSurfaceNormals properties vary across ParaView/VTK
    # builds (this droplet's apt-packaged ParaView doesn't expose
    # AutoOrientNormals, which other versions do) -- guard each one so an
    # absent property is just skipped rather than raising AttributeError
    # and aborting the whole render.
    if hasattr(normals, 'Consistency'):
        normals.Consistency = 1
    if hasattr(normals, 'AutoOrientNormals'):
        normals.AutoOrientNormals = 1
    normals.UpdatePipeline()

    cp_lo, cp_hi = CP_COLOR_RANGE

    view = CreateRenderView()
    view.ViewSize = [1280, 720]
    view.Background = [0.043, 0.055, 0.098]  # matches CAUCSim UI dark background
    view.UseColorPaletteForBackground = 0
    view.OrientationAxesVisibility = 0

    print("[INFO] Coloring surface by Cp...")
    display = Show(normals, view)
    ColorBy(display, ('POINTS', 'Cp'))

    cp_lut = GetColorTransferFunction('Cp')
    cp_lut.ApplyPreset('Turbo', True)
    cp_lut.RescaleTransferFunction(cp_lo, cp_hi)
    display.LookupTable = cp_lut

    print("[INFO] Rendering isometric view...")
    view.CameraParallelProjection = 0
    view.CameraPosition = [-2.5, -3.5, 2.0]
    view.CameraFocalPoint = [1.0, 0.0, 0.3]
    view.CameraViewUp = [0.0, 0.0, 1.0]
    # Must use the module-level ResetCamera(view) here, not view.ResetCamera() --
    # the latter is a no-op proxy call that leaves the manually-set position
    # untouched; only the wrapped function actually recomputes position/scale
    # to fit the surface geometry's bounds.
    ResetCamera(view)
    Render()

    png_path = os.path.join(output_dir, 'pressure_surface.png')
    SaveScreenshot(png_path, view)
    print(f"[INFO] Saved screenshot: {png_path}")

    # InlineData embeds the binary buffer as a base64 data URI directly in the
    # .gltf JSON, producing a single self-contained file (no separate .bin) --
    # matches render_flow.py's convention, keeping this a single S3 object.
    gltf_path = os.path.join(output_dir, 'pressure_surface.gltf')
    print(f"[INFO] Exporting Cp-colored surface to GLTF: {gltf_path}")
    ExportView(gltf_path, view=view, InlineData=1)

    range_path = os.path.join(output_dir, 'pressure_range.json')
    with open(range_path, 'w') as f:
        json.dump({'cpMin': cp_lo, 'cpMax': cp_hi}, f)
    print(f"[INFO] Wrote Cp range: {range_path} ({cp_lo:.3f} to {cp_hi:.3f})")

    print("[SUCCESS] Headless ParaView surface pressure processing complete.")

if __name__ == '__main__':
    main()
