#!/usr/bin/env bash
#
# setup-paraview.sh — install headless ParaView (pvpython) on a droplet that
# already has OpenFOAM installed, so app.js's droplet script can run
# `pvpython render_flow.py` to produce the 3D streamlines PNG/GLTF.
#
# Run this on the SAME build droplet right after setup-droplet.sh (before
# snapshotting), or on a fresh droplet booted FROM the existing openfoam-base
# snapshot. Either way, re-snapshot afterwards so 'openfoam-base' has both
# OpenFOAM and ParaView.
#
#   scp setup-paraview.sh root@<build-droplet-ip>:~
#   ssh root@<build-droplet-ip> 'bash setup-paraview.sh'
#
# Uses Kitware's prebuilt "osmesa" (Off-Screen Mesa) Linux binary — pure
# software rendering, no GPU and no X server required. This matters because
# CAUCSim's droplets (gd-16vcpu-64gb) have no GPU, and the standard apt
# `paraview` package is built against GLX and expects a display. The
# generic-apt / GLX-and-a-display route is deliberately avoided here.
#
set -euo pipefail

# Bump these together if the download 404s -- Kitware doesn't keep every
# version's tarball name predictable forever. To find the current one:
# https://www.paraview.org/download/ -> Linux -> "headless" osmesa build,
# copy the exact filename it links to.
PV_VERSION="5.13"
PV_FILENAME="ParaView-5.13.2-osmesa-MPI-Linux-Python3.10-x86_64.tar.gz"
PV_INSTALL_ROOT="/opt/paraview-5.13.2"

[[ $EUID -eq 0 ]] || { echo "Run as root (DO droplets default to root)." >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive

echo "==> Installing prerequisites ..."
apt-get update
apt-get -y install wget libgomp1

echo "==> Downloading ParaView ${PV_FILENAME} ..."
TMP_TARBALL="/tmp/${PV_FILENAME}"
wget -q --show-progress -O "$TMP_TARBALL" \
  "https://www.paraview.org/paraview-downloads/download.php?submit=Download&version=v${PV_VERSION}&type=binary&os=Linux&downloadFile=${PV_FILENAME}"

echo "==> Extracting to ${PV_INSTALL_ROOT} ..."
rm -rf "$PV_INSTALL_ROOT"
mkdir -p "$PV_INSTALL_ROOT"
tar -xzf "$TMP_TARBALL" -C "$PV_INSTALL_ROOT" --strip-components=1
rm -f "$TMP_TARBALL"

echo "==> Linking /opt/paraview -> ${PV_INSTALL_ROOT} ..."
ln -sfn "$PV_INSTALL_ROOT" /opt/paraview

echo "==> Symlinking pvpython/pvbatch onto PATH (/usr/local/bin) ..."
ln -sf /opt/paraview/bin/pvpython /usr/local/bin/pvpython
ln -sf /opt/paraview/bin/pvbatch /usr/local/bin/pvbatch

echo "==> Verifying the install resolves ..."
if ! command -v pvpython >/dev/null; then
  echo "ERROR: pvpython not found on PATH after install." >&2
  exit 1
fi
pvpython --version

echo "==> Running a headless offscreen render smoke test ..."
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
pvpython /tmp/paraview_smoke_test.py
rm -f /tmp/paraview_smoke_test.py

if [ -s "$SMOKE_TEST_PNG" ]; then
  echo "    OK — rendered $(stat -c%s "$SMOKE_TEST_PNG") byte screenshot with no display attached."
  rm -f "$SMOKE_TEST_PNG"
else
  echo "ERROR: smoke-test screenshot was not created (headless rendering did not work)." >&2
  exit 1
fi

cat <<EOF

============================================================
 ParaView ${PV_VERSION} (osmesa, headless) installed successfully.
 pvpython is on PATH at /usr/local/bin/pvpython.

 Caveat: ParaView's Python API has changed property names between
 versions before (e.g. Tube.NumberOfSides vs NumberofSides). Before
 relying on this in production, do one real end-to-end CFD run and
 confirm render_flow.py actually produces flow_streamlines_3d.png /
 flow_3d_streamlines.gltf in S3 -- if it errors, check simulation
 output for a Python AttributeError from render_flow.py and adjust
 the property name to match this ParaView version's API.

 Next steps to update your reusable snapshot (run LOCALLY):

   # 1. Power off cleanly (snapshots are most reliable when off)
   doctl compute droplet-action shutdown <DROPLET_ID> --wait

   # 2. Snapshot it — this name must match SNAPSHOT_NAME / the
   #    DIGITALOCEAN_SNAPSHOT_NAME env var (default 'openfoam-base')
   doctl compute droplet snapshot <DROPLET_ID> \\
       --snapshot-name openfoam-base --wait

   # 3. Destroy the build droplet (stops billing — powered-off still bills)
   doctl compute droplet delete <DROPLET_ID> -f

 From now on, CFD jobs launched from 'openfoam-base' will have both
 OpenFOAM and pvpython available.
============================================================
EOF
