#!/usr/bin/env bash
#
# setup-openfoam.sh — install OpenFOAM 13 on a fresh Ubuntu 24.04 droplet.
#
# Run this ONCE on a clean droplet, confirm it works, then snapshot the
# droplet. Every future run-cfd.sh launch boots from that snapshot with
# OpenFOAM already installed.
#
# Build on a cheap droplet (e.g. s-4vcpu-8gb) — installing is just apt, it
# doesn't compile anything, and a snapshot can be relaunched at ANY size
# later (a c-16 boots fine from a snapshot built on a small droplet).
#
#   scp setup-openfoam.sh root@<build-droplet-ip>:~
#   ssh root@<build-droplet-ip> 'bash setup-openfoam.sh'
#
set -euo pipefail

OF_VERSION="13"   # OpenFOAM Foundation pack: openfoam13 -> /opt/openfoam13

[[ $EUID -eq 0 ]] || { echo "Run as root (DO droplets default to root)." >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive

echo "==> Updating base system ..."
apt-get update
apt-get -y upgrade

echo "==> Installing prerequisites ..."
apt-get -y install software-properties-common wget rsync

echo "==> Adding the OpenFOAM Foundation apt repository ..."
# Official method: https key for verification, http repo for fetching.
sh -c "wget -qO - https://dl.openfoam.org/gpg.key > /etc/apt/trusted.gpg.d/openfoam.asc"
add-apt-repository -y "http://dl.openfoam.org/ubuntu"
apt-get update

echo "==> Installing openfoam${OF_VERSION} (this pulls ParaView as a dependency) ..."
apt-get -y install "openfoam${OF_VERSION}"

echo "==> Wiring the OpenFOAM environment into root's shell ..."
BASHRC_LINE="source /opt/openfoam${OF_VERSION}/etc/bashrc"
grep -qxF "$BASHRC_LINE" /root/.bashrc || echo "$BASHRC_LINE" >> /root/.bashrc

echo "==> Verifying the install ..."
# Source in a subshell and check a core app resolves.
if bash -lc "source /opt/openfoam${OF_VERSION}/etc/bashrc && command -v blockMesh >/dev/null"; then
  echo "    OK — blockMesh found."
else
  echo "ERROR: OpenFOAM environment did not load correctly." >&2
  exit 1
fi

echo "==> Installing job-runtime tools (unzip, zip, curl, numpy, matplotlib) ..."
# These are used on every job run by app.js's droplet script (template
# extraction, S3 uploads, the 2D flow-slice plot). Baking them into the
# snapshot means every job skips this apt install at boot; app.js still
# falls back to installing them itself if it finds them missing, so this
# step is not required for jobs to work -- just faster when present.
apt-get -y install unzip zip curl python3-numpy python3-matplotlib

echo "==> Installing AWS CLI v2 ..."
# Used throughout app.js's droplet script for every S3 upload/download and
# job status callback -- unlike the packages above, this one IS required
# for a job to do anything at all, so it's worth getting right here.
curl -s "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp
/tmp/aws/install
rm -rf /tmp/awscliv2.zip /tmp/aws/

echo "==> Verifying job-runtime tools ..."
if command -v unzip >/dev/null && command -v zip >/dev/null && command -v curl >/dev/null \
   && command -v aws >/dev/null && python3 -c "import numpy, matplotlib" >/dev/null 2>&1; then
  echo "    OK — unzip, zip, curl, aws ($(aws --version)), numpy, and matplotlib all resolve."
else
  echo "ERROR: one or more job-runtime tools did not install correctly." >&2
  exit 1
fi

cat <<EOF

============================================================
 OpenFOAM ${OF_VERSION} and job-runtime tools (unzip/zip/curl/AWS CLI v2/
 numpy/matplotlib) installed successfully.

 Next steps to create your reusable snapshot (run LOCALLY):

   # 1. Power off cleanly (snapshots are most reliable when off)
   doctl compute droplet-action shutdown <DROPLET_ID> --wait

   # 2. Snapshot it — this name must match SNAPSHOT_NAME in run-cfd.sh
   doctl compute droplet-action snapshot <DROPLET_ID> \\
       --snapshot-name openfoam-base --wait

   # 3. Destroy the build droplet (stops billing — powered-off still bills)
   doctl compute droplet delete <DROPLET_ID> -f

 From now on, run-cfd.sh launches everything from 'openfoam-base'.
============================================================
EOF
