# Droplet Base Image Setup Guide - CAUCSim

This document describes how to build and maintain the pre-baked DigitalOcean snapshot (`openfoam-base` by default) that CAUCSim's CFD droplets boot from. Every simulation droplet is ephemeral — it boots, runs one job, uploads results, and self-destructs (see [ARCHITECTURE.md](file:///Users/paulwilliams/Documents/Programming/CAUCSim/Documentation/ARCHITECTURE.md)) — so OpenFOAM and ParaView must already be installed on the snapshot image rather than installed fresh on every run, which would add several minutes and a large download to every single job.

---

## 1. What's on the Snapshot

*   **OpenFOAM 13**, installed to `/opt/openfoam13` via the official OpenFOAM Foundation apt repository. Provides `blockMesh`, `snappyHexMesh`, `simpleFoam`/`foamRun`, `potentialFoam`, etc. — everything the droplet's `Allrun` script needs.
*   **Job-runtime tools**: `unzip`, `zip`, `curl`, `python3-numpy`, `python3-matplotlib`, and **AWS CLI v2**. Used on every single job run — `aws` for every S3 upload/download and status callback, `unzip`/`zip` for the case template and results package, numpy/matplotlib by `generate_slice.py` for the 2D flow slice. `app.js`'s droplet script checks for each with `command -v` and installs anything missing itself, so a snapshot without these still works — it's just slower (an `apt-get update` plus a real AWS CLI download on every job) and has one more thing that can transiently fail at boot (a flaky apt mirror or network blip). Baking them in avoids both.
*   **ParaView (`pvpython`) + Xvfb**. `pvpython` is the apt `paraview` package (already pulled in as a dependency of `openfoam13`), run headlessly by wrapping every invocation in `xvfb-run -a --server-args='-screen 0 1280x1024x24'` (a bare `pvpython` call has no display and crashes). Used by `openfoam-template/render_flow.py` to render the 3D streamlines PNG and GLTF model. This step is optional in the sense that the droplet script checks `command -v pvpython`/`xvfb-run` and skips 3D visualisation gracefully (without failing the job) if either is missing — but without it, jobs will only ever produce the 2D centerline slice, not the 3D streamlines artifacts.

Both installer scripts live in [scripts/](file:///Users/paulwilliams/Documents/Programming/CAUCSim/scripts):
*   [setup-droplet.sh](file:///Users/paulwilliams/Documents/Programming/CAUCSim/scripts/setup-droplet.sh) — installs OpenFOAM 13 and the job-runtime tools above.
*   [setup-paraview.sh](file:///Users/paulwilliams/Documents/Programming/CAUCSim/scripts/setup-paraview.sh) — installs the apt `paraview` package and `xvfb`.

> **Why not a standalone headless build?** Kitware's prebuilt "osmesa" (Off-Screen Mesa, no X server or GPU needed at all) Linux binary was tried first, since it's the more obviously "correct" choice for a GPU-less droplet. It segfaulted deep inside Mesa/glew during GL context creation on this droplet's Ubuntu 24.04 + Mesa combination, and none of the standard fixes (`GALLIUM_DRIVER=llvmpipe`, `LIBGL_ALWAYS_SOFTWARE=1`, explicit `LD_LIBRARY_PATH`) resolved it. The apt package + `xvfb-run` is a much more battle-tested combination and was confirmed working end-to-end.

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

### Step 2: Install OpenFOAM and job-runtime tools
```bash
scp scripts/setup-droplet.sh root@<build-droplet-ip>:~
ssh root@<build-droplet-ip> 'bash setup-droplet.sh'
```
This adds the OpenFOAM Foundation apt repository, installs `openfoam13`, wires `source /opt/openfoam13/etc/bashrc` into root's `.bashrc`, and verifies `blockMesh` resolves. It also installs `unzip`/`zip`/`curl`/`python3-numpy`/`python3-matplotlib` and AWS CLI v2, and verifies all of them resolve before continuing.

### Step 3: Install headless ParaView
```bash
scp scripts/setup-paraview.sh root@<build-droplet-ip>:~
ssh root@<build-droplet-ip> 'bash setup-paraview.sh'
```
This installs the apt `paraview` package and `xvfb`, then runs a real headless render smoke test (`xvfb-run -a --server-args='-screen 0 1280x1024x24' pvpython ...`, rendering a sphere to a PNG with no real display attached) so a broken install fails loudly here rather than silently mid-job. If you previously ran an older version of this script that installed Kitware's osmesa binary, it cleans that up first (`/opt/paraview-*`, the `/usr/local/bin` symlinks).

> **Version caveat:** ParaView's Python API has changed property names between versions before (e.g. `Tube.NumberOfSides` vs `NumberofSides`). The smoke test only confirms rendering works at all, not that `render_flow.py` specifically is compatible with the installed version. After building the snapshot, run one real end-to-end CFD job (Step 5) and check `simulation.log` isn't hiding a Python `AttributeError` from `render_flow.py` before relying on it in production.

### Step 4: Snapshot the droplet
```bash
# Power off cleanly -- snapshots are most reliable when the droplet is off
doctl compute droplet-action shutdown <DROPLET_ID> --wait

# Snapshot it -- this name must match DIGITALOCEAN_SNAPSHOT_NAME (default 'openfoam-base')
doctl compute droplet-action snapshot <DROPLET_ID> --snapshot-name openfoam-base --wait

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

1.  Boot a new droplet **from the existing `openfoam-base` snapshot** instead of a bare Ubuntu image — this way you keep whatever is already installed (e.g. OpenFOAM) and only need to run the one installer script you're adding or updating. Look up the snapshot's numeric image ID first (`doctl compute image list --public=false | grep openfoam-base`), then:
    ```bash
    doctl compute droplet create caucsim-build \
      --region lon1 \
      --size <a size that meets the gotcha below> \
      --image <SNAPSHOT_ID> \
      --ssh-keys <your-ssh-key-fingerprint> \
      --wait
    ```
2.  Run the relevant `scp`/`ssh` install step from Section 3.
3.  Repeat Step 4 above (shutdown, snapshot, delete the temporary droplet).

### Gotcha: the new droplet's disk must be >= the snapshot's disk
DigitalOcean won't restore a snapshot onto a droplet with a smaller disk than it was taken from, regardless of droplet size/CPU/RAM — you'll get `422 Cannot create a droplet with a smaller disk than the image`. Check the snapshot's minimum first (`doctl compute image list --public=false --format ID,Name,MinDiskSize`) and pick a size whose disk meets or exceeds it:
```bash
doctl compute size list --format Slug,Disk,PriceMonthly --no-header | awk -v min=<MIN_DISK_GB> '$2 >= min' | sort -k3 -n
```
`openfoam-base` (built on a `gd-16vcpu-64gb`) currently requires a 240GB+ disk — `s-4vcpu-8gb-240gb-intel` is the cheapest size clearing that bar (a few cents for a short build session, despite the ~$64/mo sticker price).

### Gotcha: duplicate snapshot names
`doctl compute droplet-action snapshot --snapshot-name openfoam-base` always creates a **new** snapshot resource — it does not overwrite the old one in place. The app resolves the image to boot from by name (`app.js`'s job-creation handler calls `GET /v2/images?private=true` and takes the **first** image whose name matches `DIGITALOCEAN_SNAPSHOT_NAME`) unless `DIGITALOCEAN_IMAGE_ID` is pinned explicitly in `.env`. If you leave two snapshots both named `openfoam-base`, which one new jobs actually boot from is not guaranteed by name alone. After confirming the new snapshot works (Step 5), delete the old one:
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
