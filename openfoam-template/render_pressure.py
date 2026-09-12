#!/usr/bin/env pvpython
# ==============================================================================
# Script: render_pressure.py
# Description: Headless ParaView (pvpython) post-processing script that
#              colors the car body surface (patch f24, exported by
#              `foamToVTK -patches '(f24)' -fields '(p)'`) by pressure
#              coefficient Cp, and exports an interactive GLTF scene for the
#              CAUCSim Three.js viewer, plus a small JSON sidecar recording
#              the Cp range for the frontend legend.
# ==============================================================================

import json
import os
import sys

from paraview.simple import *


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

    data_info = calc.GetDataInformation()
    cp_array_info = data_info.GetPointDataInformation().GetArrayInformation('Cp')
    cp_range = cp_array_info.GetComponentRange(0)

    view = CreateRenderView()
    view.ViewSize = [1280, 720]
    view.Background = [0.043, 0.055, 0.098]  # matches CAUCSim UI dark background
    view.UseColorPaletteForBackground = 0
    view.OrientationAxesVisibility = 0

    print("[INFO] Coloring surface by Cp...")
    display = Show(calc, view)
    ColorBy(display, ('POINTS', 'Cp'))

    cp_lut = GetColorTransferFunction('Cp')
    # Cp is signed and diverging around 0 -- unlike render_flow.py's velocity
    # magnitude (sequential, 'Rainbow Desaturated'), use a diverging preset.
    cp_lut.ApplyPreset('Cool to Warm', True)
    # Cp's range varies run-to-run (unlike U's fixed 0-30 m/s scale in
    # render_flow.py), so rescale to the actual data range just computed.
    cp_lut.RescaleTransferFunction(cp_range[0], cp_range[1])
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
        json.dump({'cpMin': cp_range[0], 'cpMax': cp_range[1]}, f)
    print(f"[INFO] Wrote Cp range: {range_path} ({cp_range[0]:.3f} to {cp_range[1]:.3f})")

    print("[SUCCESS] Headless ParaView surface pressure processing complete.")

if __name__ == '__main__':
    main()
