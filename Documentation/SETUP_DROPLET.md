# Droplet Base Image Setup Guide - CAUCSim

This document describes how to build and maintain the pre-baked DigitalOcean snapshot (`openfoam-base` by default) that CAUCSim's CFD droplets boot from. Every simulation droplet is ephemeral — it boots, runs one job, uploads results, and self-destructs (see [ARCHITECTURE.md](file:///Users/paulwilliams/Documents/Programming/CAUCSim/Documentation/ARCHITECTURE.md)) — so OpenFOAM and ParaView must already be installed on the snapshot image rather than installed fresh on every run, which would add several minutes and a large download to every single job.

---

## 1. What's on the Snapshot

*   **OpenFOAM 13**, installed to `/opt/openfoam13` via the official OpenFOAM Foundation apt repository. Provides `blockMesh`, `snappyHexMesh`, `simpleFoam`/`foamRun`, `potentialFoam`, etc. — everything the droplet's `Allrun` script needs.
*   **Headless ParaView (`pvpython`)**, installed to `/opt/paraview` and symlinked onto `PATH` at `/usr/local/bin/pvpython`. Used by `openfoam-template/render_flow.py` to render the 3D streamlines PNG and GLTF model. This step is optional in the sense that the droplet script checks `command -v pvpython` and skips 3D visualisation gracefully (without failing the job) if it isn't present — but without it, jobs will only ever produce the 2D centerline slice, not the 3D streamlines artifacts.

Both installer scripts live in [scripts/](file:///Users/paulwilliams/Documents/Programming/CAUCSim/scripts):
*   [setup-droplet.sh](file:///Users/paulwilliams/Documents/Programming/CAUCSim/scripts/setup-droplet.sh) — installs OpenFOAM 13.
*   [setup-paraview.sh](file:///Users/paulwilliams/Documents/Programming/CAUCSim/scripts/setup-paraview.sh) — installs headless ParaView (Kitware's prebuilt **osmesa** Linux binary — pure software rendering, chosen specifically because CAUCSim's droplets (`gd-16vcpu-64gb`) have no GPU and no X server, which rules out the standard apt `paraview` package (GLX-based, expects a display)).

---

## 2. Prerequisites

*   A DigitalOcean account with the [doctl](https://docs.digitalocean.com/reference/doctl/how-to/install/) CLI installed and authenticated (`doctl auth init`).
*   An SSH key added to your DigitalOcean account, so you can `scp`/`ssh` into the build droplet.
*   The `DIGITALOCEAN_TOKEN` used by `doctl` should have write access to Droplets, Images, and Snapshots.

---

## 3. Building the Snapshot From Scratch

### Step 1: Create a cheap build droplet
Installing is just `apt`/downloading a tarball — it doesn't compile anything — so build on a cheap droplet. A snapshot taken from a small droplet can be relaunched at any size later (a `gd-16vcpu-64gb` boots fine from a snapshot built on an `s-4vcpu-8gb`).

```bash
doctl compute droplet create caucsim-build \
  --region lon1 \
  --size s-4vcpu-8gb \
  --image ubuntu-24-04-x64 \
  --ssh-keys <your-ssh-key-fingerprint> \
  --wait
```

Note the droplet's IP address and ID from the output (or `doctl compute droplet list`).

### Step 2: Install OpenFOAM
```bash
scp scripts/setup-droplet.sh root@<build-droplet-ip>:~
ssh root@<build-droplet-ip> 'bash setup-droplet.sh'
```
This adds the OpenFOAM Foundation apt repository, installs `openfoam13`, wires `source /opt/openfoam13/etc/bashrc` into root's `.bashrc`, and verifies `blockMesh` resolves.

### Step 3: Install headless ParaView
```bash
scp scripts/setup-paraview.sh root@<build-droplet-ip>:~
ssh root@<build-droplet-ip> 'bash setup-paraview.sh'
```
This downloads and extracts the ParaView osmesa binary, symlinks `pvpython`/`pvbatch` onto `PATH`, and runs a real headless render smoke test (renders a sphere to a PNG with no display attached) so a broken install fails loudly here rather than silently mid-job.

> **Version caveat:** ParaView's Python API has changed property names between versions before (e.g. `Tube.NumberOfSides` vs `NumberofSides`). The smoke test only confirms rendering works at all, not that `render_flow.py` specifically is compatible with the installed version. After building the snapshot, run one real end-to-end CFD job (Step 5) and check `simulation.log` isn't hiding a Python `AttributeError` from `render_flow.py` before relying on it in production.

### Step 4: Snapshot the droplet
```bash
# Power off cleanly -- snapshots are most reliable when the droplet is off
doctl compute droplet-action shutdown <DROPLET_ID> --wait

# Snapshot it -- this name must match DIGITALOCEAN_SNAPSHOT_NAME (default 'openfoam-base')
doctl compute droplet snapshot <DROPLET_ID> --snapshot-name openfoam-base --wait

# Destroy the build droplet -- stops billing (a powered-off droplet still bills)
doctl compute droplet delete <DROPLET_ID> -f
```

### Step 5: Verify
Confirm `.env`'s `DIGITALOCEAN_SNAPSHOT_NAME` (or `DIGITALOCEAN_IMAGE_ID`, see below) matches the snapshot name you just created — see [.env.example](file:///Users/paulwilliams/Documents/Programming/CAUCSim/.env.example). Then trigger one real simulation from the app and confirm:
*   The job completes successfully.
*   `results/<jobId>/flow_slice.png` is uploaded (2D slice — OpenFOAM only).
*   `results/<jobId>/flow_streamlines_3d.png` and `results/<jobId>/flow_3d_streamlines.gltf` are uploaded (3D streamlines — confirms ParaView is working end-to-end).

---

## 4. Updating an Existing Snapshot (e.g. Adding ParaView Later)

You don't need to rebuild from scratch to add or update one piece of software:

1.  Boot a new droplet **from the existing `openfoam-base` snapshot** (`doctl compute droplet create --image openfoam-base ...`) instead of a bare Ubuntu image — this way you keep whatever is already installed (e.g. OpenFOAM) and only need to run the one installer script you're adding or updating.
2.  Run the relevant `scp`/`ssh` install step from Section 3.
3.  Repeat Step 4 above (shutdown, snapshot, delete the temporary droplet).

### Gotcha: duplicate snapshot names
`doctl compute droplet snapshot --snapshot-name openfoam-base` always creates a **new** snapshot resource — it does not overwrite the old one in place. The app resolves the image to boot from by name (`app.js`'s job-creation handler calls `GET /v2/images?private=true` and takes the **first** image whose name matches `DIGITALOCEAN_SNAPSHOT_NAME`) unless `DIGITALOCEAN_IMAGE_ID` is pinned explicitly in `.env`. If you leave two snapshots both named `openfoam-base`, which one new jobs actually boot from is not guaranteed by name alone. After confirming the new snapshot works (Step 5), delete the old one:
```bash
doctl compute image list --public=false
doctl compute image delete <OLD_SNAPSHOT_ID>
```
Alternatively, pin `DIGITALOCEAN_IMAGE_ID` in `.env` to the exact new snapshot's ID to sidestep name resolution entirely.

---

## 5. Related Configuration

Set in `.env` (see [.env.example](file:///Users/paulwilliams/Documents/Programming/CAUCSim/.env.example) and [AWSCONFIG.md](file:///Users/paulwilliams/Documents/Programming/CAUCSim/Documentation/AWSCONFIG.md) for the full production config reference):

| Variable | Default | Purpose |
|---|---|---|
| `DIGITALOCEAN_TOKEN` | — | API token used both by the app to provision job droplets and by `doctl` for the build workflow above. |
| `DIGITALOCEAN_SNAPSHOT_NAME` | `openfoam-base` | Name the app looks up via the Images API to find the boot image (see the duplicate-name gotcha above). |
| `DIGITALOCEAN_IMAGE_ID` | — | If set, skips the name lookup entirely and boots this exact image ID. |
| `DIGITALOCEAN_REGION` | `lon1` | Region job droplets are created in — build your snapshot in the same region to avoid cross-region image copy delays. |
| `DIGITALOCEAN_SIZE` | `gd-16vcpu-64gb` | Size job droplets are created at (irrelevant to the build droplet, which can be much smaller). |
