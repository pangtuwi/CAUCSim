#!/usr/bin/env pvpython
# ==============================================================================
# Script: render_flow.py
# Description: Headless ParaView (pvpython) post-processing script that
#              renders the OpenFOAM `streamlines` function object's track
#              output as a 3D isometric PNG and exports an interactive GLTF
#              scene for the CAUCSim Three.js viewer.
# ==============================================================================

import os
import sys

from paraview.simple import *

def main():
    if len(sys.argv) < 2:
        print("Usage: pvpython render_flow.py <tracks_file> [output_dir]")
        sys.exit(1)

    tracks_path = sys.argv[1]
    output_dir = sys.argv[2] if len(sys.argv) > 2 else os.getcwd()

    if not os.path.exists(tracks_path):
        print(f"Error: {tracks_path} does not exist")
        sys.exit(1)

    print(f"[INFO] Loading streamline tracks from {tracks_path}...")
    reader = OpenDataFile(tracks_path)
    reader.UpdatePipeline()

    # The streamlines function object's lifeTime lets tracks travel far
    # downstream (observed ~15m on a real case vs. a ~2.4m F24 car). Unlike
    # generate_slice.py's flat 2D contour (where a longer x-range is fine),
    # an oblique 3D isometric view of a long thin volume collapses to a
    # near-invisible diagonal sliver -- so crop tightly to the car body plus
    # a short near-wake to keep the tubes large and legible in frame.
    clip = Clip(Input=reader)
    clip.ClipType = 'Box'
    clip.ClipType.Position = [-1.0, -1.5, -0.5]
    clip.ClipType.Length = [4.0, 3.0, 3.0]
    clip.Invert = 1
    clip.UpdatePipeline()

    # Clip always outputs vtkUnstructuredGrid; Tube requires vtkPolyData input
    surface = ExtractSurface(Input=clip)
    surface.UpdatePipeline()

    view = CreateRenderView()
    view.ViewSize = [1280, 720]
    view.Background = [0.043, 0.055, 0.098]  # matches CAUCSim UI dark background
    view.UseColorPaletteForBackground = 0
    view.OrientationAxesVisibility = 0

    print("[INFO] Building streamline tubes...")
    tubes = Tube(Input=surface)
    tubes.Radius = 0.006
    tubes.NumberofSides = 8

    tube_display = Show(tubes, view)
    ColorBy(tube_display, ('POINTS', 'U', 'Magnitude'))

    u_lut = GetColorTransferFunction('U')
    u_lut.ApplyPreset('Rainbow Desaturated', True)
    u_lut.RescaleTransferFunction(0.0, 30.0)  # 0-30 m/s, matches generate_slice.py's scale
    tube_display.LookupTable = u_lut

    print("[INFO] Rendering isometric view...")
    view.CameraParallelProjection = 0
    view.CameraPosition = [-2.5, -3.5, 2.0]
    view.CameraFocalPoint = [1.0, 0.0, 0.3]
    view.CameraViewUp = [0.0, 0.0, 1.0]
    # Must use the module-level ResetCamera(view) here, not view.ResetCamera() --
    # the latter is a no-op proxy call that leaves the manually-set position
    # untouched; only the wrapped function actually recomputes position/scale
    # to fit the tube geometry's bounds.
    ResetCamera(view)
    Render()

    png_path = os.path.join(output_dir, 'flow_streamlines_3d.png')
    SaveScreenshot(png_path, view)
    print(f"[INFO] Saved screenshot: {png_path}")

    # InlineData embeds the binary buffer as a base64 data URI directly in the
    # .gltf JSON, producing a single self-contained file (no separate .bin) --
    # this ParaView build's exporter only recognizes the .gltf extension (no
    # native .glb support), so InlineData is what keeps this a single S3 object.
    gltf_path = os.path.join(output_dir, 'flow_3d_streamlines.gltf')
    print(f"[INFO] Exporting 3D scene to GLTF: {gltf_path}")
    ExportView(gltf_path, view=view, InlineData=1)

    print("[SUCCESS] Headless ParaView 3D streamlines processing complete.")

if __name__ == '__main__':
    main()
