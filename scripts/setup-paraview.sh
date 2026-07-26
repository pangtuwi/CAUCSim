#!/usr/bin/env bash
#
# setup-paraview.sh — set up headless ParaView (pvpython) on a droplet that
# already has OpenFOAM installed, so app.js's droplet script can run
# `xvfb-run -a ... pvpython render_flow.py` to produce the 3D streamlines
# PNG/GLTF.
#
# Run this on the SAME build droplet right after setup-droplet.sh (before
# snapshotting), or on a fresh droplet booted FROM the existing openfoam-base
# snapshot. Either way, re-snapshot afterwards so 'openfoam-base' has both
# OpenFOAM and ParaView.
#
#   scp setup-paraview.sh root@<build-droplet-ip>:~
#   ssh root@<build-droplet-ip> 'bash setup-paraview.sh'
#
# Uses the apt `paraview` package (already pulled in as a dependency of
# `openfoam13` -- see setup-droplet.sh) wrapped in `xvfb-run`, rather than
# Kitware's standalone "osmesa" prebuilt binary. The osmesa binary was tried
# first (no X server / GPU needed at all) but segfaulted deep in Mesa/glew
# on this droplet's Ubuntu 24.04 + Mesa combination, with no fix found after
# trying the standard GALLIUM_DRIVER/LIBGL_ALWAYS_SOFTWARE/LD_LIBRARY_PATH
# workarounds. The apt package + a virtual framebuffer is a much more
# battle-tested combination and was confirmed working end-to-end here.
#
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Run as root (DO droplets default to root)." >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive

# Clean up any leftovers from a previous run of the old Kitware-osmesa
# version of this script, if present -- harmless no-ops otherwise.
echo "==> Removing any previous Kitware osmesa ParaView install ..."
rm -f /usr/local/bin/pvpython /usr/local/bin/pvbatch
rm -f /opt/paraview
rm -rf /opt/paraview-*

echo "==> Installing ParaView and a virtual framebuffer (Xvfb) ..."
apt-get update
apt-get -y install paraview xvfb

echo "==> Verifying pvpython resolves ..."
if ! command -v pvpython >/dev/null; then
  echo "ERROR: pvpython not found on PATH after install." >&2
  exit 1
fi
pvpython --version

echo "==> Running a headless offscreen render smoke test (xvfb-run) ..."
SMOKE_TEST_PNG="/tmp/paraview-smoke-test.png"
rm -f "$SMOKE_TEST_PNG"
cat > /tmp/paraview_smoke_test.py <<'EOF'
from paraview.simple import *
view = CreateRenderView()
view.ViewSize = [400, 300]
sphere = Sphere()
Show(sphere, view)
Render()
SaveScreenshot('/tmp/paraview-smoke-test.png', view)
print("SMOKE_TEST_OK")
EOF
# The explicit --server-args screen size matters -- xvfb-run's bare defaults
# were not enough here; ParaView's vtkXOpenGLRenderWindow aborted with "bad
# X server connection" against them.
xvfb-run -a --server-args='-screen 0 1280x1024x24' pvpython /tmp/paraview_smoke_test.py
rm -f /tmp/paraview_smoke_test.py

if [ -s "$SMOKE_TEST_PNG" ]; then
  echo "    OK — rendered $(stat -c%s "$SMOKE_TEST_PNG") byte screenshot with no display attached."
  rm -f "$SMOKE_TEST_PNG"
else
  echo "ERROR: smoke-test screenshot was not created (headless rendering did not work)." >&2
  exit 1
fi

cat <<'EOF'

============================================================
 ParaView (apt package, via xvfb-run) installed successfully.
 pvpython is on PATH at /usr/bin/pvpython.

 IMPORTANT: pvpython must always be invoked through xvfb-run with an
 explicit screen size, e.g.:

   xvfb-run -a --server-args='-screen 0 1280x1024x24' pvpython render_flow.py ...

 A bare `pvpython` call will crash (no display). app.js's droplet
 script already wraps its invocation this way -- match it if you add
 any other pvpython call sites.

 Next steps to update your reusable snapshot (run LOCALLY):

   # 1. Power off cleanly (snapshots are most reliable when off)
   doctl compute droplet-action shutdown <DROPLET_ID> --wait

   # 2. Snapshot it -- this name must match SNAPSHOT_NAME / the
   #    DIGITALOCEAN_SNAPSHOT_NAME env var (default 'openfoam-base')
   doctl compute droplet-action snapshot <DROPLET_ID> \
       --snapshot-name openfoam-base --wait

   # 3. Destroy the build droplet (stops billing -- powered-off still bills)
   doctl compute droplet delete <DROPLET_ID> -f

 From now on, CFD jobs launched from 'openfoam-base' will have both
 OpenFOAM and pvpython (via xvfb-run) available.
============================================================
EOF
