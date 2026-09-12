#!/usr/bin/env pvpython
# ==============================================================================
# Script: render_flow.py
# Description: Headless ParaView (pvpython) post-processing script that
#              renders one or more OpenFOAM `streamlines` function objects'
#              track output as a combined 3D isometric PNG, and exports each
#              set as its own self-contained GLTF scene for the CAUCSim
#              Three.js viewer. Each set is exported as a SEPARATE file
#              (rather than one combined GLTF with named toggleable nodes)
#              because ParaView's view-level GLTF exporter does not reliably
#              preserve Pipeline Browser source names as glTF node names --
#              separate files sidestep that entirely and let the browser
#              toggle each set independently just by adding/removing objects.
# ==============================================================================

import os
import sys

from paraview.simple import *

# Maps a seed-set name to the GLTF filename the frontend/backend expect.
# "current" keeps the pre-existing filename so already-uploaded jobs and any
# code path that doesn't know about the new sets is unaffected.
GLTF_FILENAMES = {
    'current': 'flow_3d_streamlines.gltf',
    'centreline': 'flow_3d_streamlines_centreline.gltf',
    'outboard': 'flow_3d_streamlines_outboard.gltf',
}

U_COLOR_RANGE = (0.0, 30.0)  # m/s, matches generate_slice.py's scale


def build_tube_pipeline(tracks_path):
    """Load one tracks file and return a ready-to-Show Tube source."""
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

    tubes = Tube(Input=surface)
    tubes.Radius = 0.006
    tubes.NumberofSides = 8
    return tubes


def style_view(view):
    view.ViewSize = [1280, 720]
    view.Background = [0.043, 0.055, 0.098]  # matches CAUCSim UI dark background
    view.UseColorPaletteForBackground = 0
    view.OrientationAxesVisibility = 0


def aim_camera(view):
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


def color_by_velocity(tube_display):
    ColorBy(tube_display, ('POINTS', 'U', 'Magnitude'))
    u_lut = GetColorTransferFunction('U')
    u_lut.ApplyPreset('Rainbow Desaturated', True)
    u_lut.RescaleTransferFunction(*U_COLOR_RANGE)
    tube_display.LookupTable = u_lut


def main():
    if len(sys.argv) < 3:
        print("Usage: pvpython render_flow.py <output_dir> <name>:<tracks_file> [<name>:<tracks_file> ...]")
        print(f"  <name> must be one of: {', '.join(GLTF_FILENAMES)}")
        sys.exit(1)

    output_dir = sys.argv[1]
    sets = []
    for arg in sys.argv[2:]:
        if ':' not in arg:
            print(f"[WARN] Skipping malformed set argument (expected name:path): {arg}")
            continue
        name, tracks_path = arg.split(':', 1)
        if name not in GLTF_FILENAMES:
            print(f"[WARN] Skipping unknown set name '{name}' (expected one of {', '.join(GLTF_FILENAMES)})")
            continue
        if not os.path.exists(tracks_path):
            print(f"[WARN] Skipping '{name}': {tracks_path} does not exist")
            continue
        sets.append((name, tracks_path))

    if not sets:
        print("Error: no valid streamline sets to render")
        sys.exit(1)

    # Build every set's tube pipeline once, up front, so the combined
    # screenshot below can show them all together.
    tubes_by_name = {}
    for name, tracks_path in sets:
        print(f"[INFO] Loading streamline tracks for '{name}' from {tracks_path}...")
        tubes_by_name[name] = build_tube_pipeline(tracks_path)

    print("[INFO] Rendering combined isometric screenshot...")
    combined_view = CreateRenderView()
    style_view(combined_view)
    for name, tubes in tubes_by_name.items():
        display = Show(tubes, combined_view)
        color_by_velocity(display)
    aim_camera(combined_view)
    png_path = os.path.join(output_dir, 'flow_streamlines_3d.png')
    SaveScreenshot(png_path, combined_view)
    print(f"[INFO] Saved screenshot: {png_path}")

    # Export each set to its own GLTF, each built in its own fresh view so
    # the exported scene graph unambiguously contains only that one set's
    # geometry -- see the module docstring for why this is separate files
    # rather than one combined export.
    for name, tubes in tubes_by_name.items():
        print(f"[INFO] Exporting '{name}' set to its own GLTF...")
        view = CreateRenderView()
        style_view(view)
        display = Show(tubes, view)
        color_by_velocity(display)
        aim_camera(view)

        gltf_path = os.path.join(output_dir, GLTF_FILENAMES[name])
        # InlineData embeds the binary buffer as a base64 data URI directly in
        # the .gltf JSON, producing a single self-contained file (no separate
        # .bin) -- this ParaView build's exporter only recognizes the .gltf
        # extension (no native .glb support), so InlineData is what keeps
        # this a single S3 object.
        ExportView(gltf_path, view=view, InlineData=1)
        print(f"[INFO] Exported: {gltf_path}")

    print("[SUCCESS] Headless ParaView 3D streamlines processing complete.")

if __name__ == '__main__':
    main()
