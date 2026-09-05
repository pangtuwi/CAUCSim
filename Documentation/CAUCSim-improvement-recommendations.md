# CAUCSim simulation accuracy review

## Context

This document comes out of a controlled aerodynamic CFD comparison in the
CAUC_F24 OpenFOAM project. The same car geometry ("Brian") was run through
several carefully-checked OpenFOAM 13 pipelines (steady and transient, at
multiple mesh resolutions, with explicit convergence verification) to build a
reliable reference result, then compared against CAUCSim's own output for the
identical geometry (case files in `openFoam/Brian_CAUCSim/`). Four issues were
found in CAUCSim's generated case configuration that reduce confidence in its
reported `Cd`/`Cl`/`Cm` relative to that reference, plus one lower-priority
consistency question. Each is described below with what was observed, why it
matters, and a recommended fix.

The specific numeric values quoted (mesh cell counts, iteration counts) are
calibrated to this one geometry/mesh scale and are meant as a concrete,
evidence-backed starting point — the more robust fix in each case is to make
the underlying behavior automatic/convergence-driven rather than a hardcoded
constant, so it generalizes to other geometries without needing to be
re-tuned by hand each time.

## 1. (Correctness bug) `lRef` in `forceCoeffs` is not computed from the actual geometry

**Observed:** `system/forceCoeffs` has `lRef 1.2` — this is a leftover default
from a different reference car model, not this geometry's actual wheelbase
(which measures 1.42 m axle-to-axle for this STL). By contrast, `Aref` in the
same file *was* correctly computed per-geometry (`0.657129`, matching this
model's real frontal area to high precision) — so the pipeline clearly has a
per-geometry area calculation already; the length reference just isn't wired
up the same way.

**Impact:** `Cm` (pitching-moment coefficient) is normalized by `lRef` in the
denominator. Using `1.2` instead of the correct `1.42` inflates the reported
`Cm` magnitude by about 18% for this geometry, independent of anything else
in the solve. `Cd`/`Cl` are unaffected by this specific issue.

**Fix:** compute `lRef` from the uploaded geometry (e.g. axle-to-axle
distance derived from wheel/contact-patch positions in the STL, or from
user-supplied vehicle dimensions if those are already collected elsewhere in
the pipeline) at case-generation time — the same way `Aref` is already
handled. Never leave a hardcoded default carried over from a template/example
vehicle.

## 2. Too few solver iterations — the reported result is not converged

**Observed:** `controlDict` sets `endTime 50` for a steady-state (`SIMPLE`)
run. The full `forceCoeffs.dat` history shows the solution still moving
substantially at iteration 50, not settled:
- `Cl` peaks around iteration 11 (+0.063), then declines steadily through
  zero (~iteration 18) down to -0.197 by iteration 50 — still changing by
  -0.0024 on the very last iteration, with the per-iteration decrement only
  just beginning to shrink.
- `Cd` is still climbing (~+0.0006/iteration at the end).

A reference run on the same geometry (same background mesh, finer surface
refinement — see #3) needed roughly 500 SIMPLE iterations before settling
into a bounded, repeatable oscillation band rather than still trending in one
direction.

**Impact:** the reported `Cd=0.315`/`Cl=-0.197` is a mid-convergence
snapshot. Running further would very likely change it substantially — it
should not be presented to a user as a final result.

**Fix:** increase `endTime` to at least 500 for this mesh/geometry class as
an immediate improvement. Better still, pair this with #4 below (a real
convergence check) so the run length adapts automatically instead of relying
on a fixed number that may not be right for a different geometry or mesh
size.

## 3. Underbody/near-surface mesh refinement is too coarse

**Observed:** `snappyHexMeshDict`'s `refinementSurfaces` uses `level (3 4)`
for the car surface. A reference case using the *same* background mesh
resolution (`blockMeshDict` blocks `20x8x8`) but `level (5 6)` produced a
final mesh over 3x denser near the body (396k cells vs CAUCSim's 126k) — two
refinement levels lower means roughly 4x coarser cells right at the surface,
where the boundary layer and near-body pressure gradients that drive
downforce actually live.

**Impact:** this project's own mesh-sensitivity check (coarsening a known-good
mesh back down while holding everything else fixed) found `Cl` shifts
measurably with surface refinement level, and downforce in particular is
sensitive to resolving the underbody flow well. CAUCSim's current level is
below what this project found adequate for this geometry class.

**Fix:** raise `refinementSurfaces` level to at least `(5 6)` to match the
resolution known to work for this class of geometry. **Check
`castellatedMeshControls`'s `maxGlobalCells` when doing this** — if it's set
too low, it will silently cap mesh growth before the requested refinement
level is actually reached everywhere, so the intended resolution increase
may not actually take effect. Raise that limit in step with the refinement
level.

## 4. No convergence check before reporting a result

**Observed:** the reported summary (`Cd`/`Cl`/`Cm` in
`Brian_CAUCSim_Results.md`) is read directly from the single last available
iteration of `forceCoeffs.dat`, with no check for whether the solution has
actually settled.

**Impact:** for bluff-body geometries like this one (open-wheel race car),
the flow exhibits a persistent, genuine oscillation even once properly
converged — real vortex shedding that a steady RANS solve cannot fully
suppress, not numerical noise. In this project's reference runs, that
oscillation amplitude was roughly ±0.003–0.008 in `Cd`/`Cl` even in a stable
regime (and much larger before that regime is reached — see #2). A single
final-iteration value is never fully representative, and reporting one
without any spread/uncertainty hides that.

**Fix:** after the solve, don't read a single final iteration. Instead:
- Take the last N iterations (e.g. the last 100–200 of a 500-iteration run)
  and compute mean ± standard deviation for `Cd`/`Cl`/`Cm`.
- Confirm the mean is insensitive to the exact window size — compare, say,
  last-100 vs last-150 vs last-200 iterations. If they agree to within a
  small tolerance, the flow has reached a statistically stationary state. If
  they don't, the run needs more iterations before anything should be
  reported.
- Report the mean **and** its spread to the user (e.g. `Cd = 0.267 ± 0.003`),
  rather than a bare point value, so residual oscillation is visible instead
  of hidden.

This is arguably the most important fix here: without it, there's no way to
tell a genuinely converged result from a lucky-looking snapshot like the one
in this run, regardless of how many iterations or how fine a mesh is used.

## 5. Simulation speed vs. reporting speed (a consistency question, not necessarily a bug)

**Observed:** this run set `magUInf` to the target race speed (13.4 m/s)
directly and solved the CFD at that speed, rather than solving once at a
fixed reference speed (e.g. 20 m/s, the convention used elsewhere in this
project) and analytically scaling the resulting dimensionless coefficients
to force/power estimates at any target speed afterward.

**Why it matters:** `Cd`/`Cl` are usually close to speed-independent in this
Reynolds-number range, so this likely doesn't change the result much on its
own — but it does mean CAUCSim's raw coefficients aren't generated under the
same convention as this project's other tooling for the same geometry, which
matters when results get compared side-by-side (as they were here).

**Fix (lower priority):** consider standardizing on one reference simulation
speed for coefficient generation, then deriving force/power at any target
speed from those coefficients afterward. This also means the CFD only needs
to run once per geometry regardless of how many target speeds are of
interest downstream, rather than re-running for each one.

## Priority

**#1 and #4 matter most.** #1 is a straightforward, low-effort correctness
bug (wrong constant, not a modeling limitation). #4 is more fundamental —
without a real convergence check, the current output can't be trusted as a
stable number at all, independent of mesh or iteration count. #2 and #3 are
what's actually needed to *reach* a trustworthy number for this geometry once
#4 exists to confirm it's been reached. #5 is a lower-priority consistency
improvement, not a bug.

---

# Resolution

How each finding was addressed. The comparison above is left unedited as the
original record.

**#1 `lRef` — fixed.** The wheelbase is now collected in Stage 3 (pre-filled
from the STL bounding-box length, overridable with the measured axle-to-axle
figure), sent with the job, and substituted into `system/forceCoeffs` by the
case-patching block in `backend/app/app.js` — the same route `Aref` already
took.

*Also found:* `CofR` was hardcoded to `(0.72 0 0)` — the same class of bug, and
`Cm` is taken about that point, so fixing `lRef` alone would have left `Cm`
referenced to a point valid only for the original car. `CofR` is now substituted
per geometry as the model's mid-length on the ground plane.

**#2 iterations — fixed.** `endTime` raised from 50 to 500 (`writeInterval`
50 → 100).

**#3 mesh refinement — fixed.** `refinementSurfaces` raised to `level (5 6)`,
`refinementBox` to `level 4`, and the background mesh to `40x16x16`.

*On `maxGlobalCells`:* checked, and no change was needed — it is `2000000`,
comfortably above the ~396k cells the refined mesh produces, so it was not
silently capping refinement.

*Context:* `openfoam-template/` had been deliberately running debug-reduced
settings for fast iteration on the visualisation pipeline; the full-resolution
values already existed in `openfoam-template_F24Steady/`. Those cheap settings
now survive as an explicit **Fast check** mode (a checkbox, off by default) that
patches the case back down at generation time, rather than as an undocumented
state of the template.

**#4 convergence check — fixed, and this drove the biggest change.** The
reported coefficients are no longer the final iteration. The droplet now simply
uploads `forceCoeffs.dat`, and the API server derives the result from it:

- `Cd`/`Cl`/`Cm` are the **mean over the last 200 iterations**, reported with
  their standard deviation, shown in the UI as `0.267 ± 0.003`.
- Convergence is judged by **window sensitivity**: the means over the last 100,
  150 and 200 iterations must agree to within `max(0.002, 1%)`. This targets
  drift between windows rather than the oscillation within them, so genuine
  vortex shedding does not read as non-convergence.
- A run that has not settled is **labelled as such in the UI**, as is any fast
  check. A 50-iteration run collapses all three windows onto the same rows, so
  it can never be certified — which is the honest answer.

This computation moved off the droplet specifically so it could be tested:
`coefficient-stats.test.js` covers it, including a regression case built from
the still-drifting iteration-50 trace described above.

**#5 reference speed — deferred, not fixed.** A deliberate decision. CAUCSim
continues to solve at the user-selected race speed, because that speed is a
built feature of the UI and the finding is rated a consistency question rather
than a bug. Worth revisiting if side-by-side comparison with the other tooling
becomes routine.
