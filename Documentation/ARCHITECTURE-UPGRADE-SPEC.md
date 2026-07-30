# CAUCSim Architecture Migration Spec

## Purpose

CAUCSim currently runs as a single Express app deployed to one AWS Lambda function
(`app.handler`), serving both the static frontend and the API. This spec describes
the target architecture: a static, CDN-hosted frontend supporting **three** distinct
UIs, a serverless API split by domain, and Step Functions-based orchestration
replacing the current bash-based droplet lifecycle management.

This document is intended to be handed to an engineering agent (Claude Code) as a
working spec. It describes target state, required changes, and data contracts.
It does not assume the agent has prior context on the app beyond the existing
repository contents.

---

## 1. Current State (for reference)

- Single Express app (`app.js`), deployed via `serverless.yaml` as one Lambda
  (`caucsim-backend`, `eu-west-2`, runtime `nodejs20.x`).
- Serves static frontend (`public/`) AND all API routes from the same handler.
- Auth: AWS Cognito, validated in-app via `aws-jwt-verify` middleware.
- Storage: direct-to-S3 uploads via presigned URLs (`@aws-sdk/s3-request-presigner`).
- Heavy compute: on-demand DigitalOcean droplets (`gd-16vcpu-64gb`) running OpenFOAM,
  orchestrated entirely by a bash boot script:
  - Patches the `Allrun` script to insert callback hooks before `potentialFoam` /
    `foamRun`.
  - Self-destructs via a background `sleep 3600` process as the only failure
    safety net.
  - Notifies job progress via HTTP callbacks to `APP_CALLBACK_URL`.
- Single UI: CFD simulation viewer (3D CAD viewport, regulations checklist,
  aero results, streamlines).

---

## 2. Target Architecture Overview

```
                         ┌────────────────────┐
        DNS (domain) ───▶│    CloudFront        │
                         └─────────┬──────────┘
                                   │
                 ┌─────────────────┼─────────────────────┐
                 │                 │                     │
           /cfd/*            /vehicle-sim/*, /compare/*   /api/*
                 │                 │                     │
                 ▼                 ▼                     ▼
        ┌─────────────┐   ┌─────────────┐        ┌──────────────────┐
        │  S3: static  │   │ S3: static   │        │  API Gateway      │
        │  cfd/ prefix │   │ other prefixes│       │  (Cognito authorizer)│
        └─────────────┘   └─────────────┘        └────────┬─────────┘
                                                            │
                     ┌──────────────────────────┼───────────────────┐
                     │                          │                   │
              /api/cfd/*, /api/vehicle/*                     /api/results/*
                     │                          │                   │
                     ▼                          │                   ▼
           ┌────────────────────────┐           │           ┌───────────────┐
           │  Shared app Lambda       │          │           │ Results Lambda │
           │  (routed: cfd/, vehicle- │          │           └───────┬───────┘
           │  sim/ handlers)          │          │                   │
           └────────┬───────────────┘           │                   ▼
                     │ (cfd routes only)         │           ┌──────────────────┐
                     ▼                           │           │ DynamoDB: results │
           ┌──────────────────┐                  │           │ index (shared)    │
           │ Step Functions     │                │           └──────────────────┘
           │ (droplet lifecycle)│                │
           └────────┬─────────┘                  │
                    │                             │
                    ▼                             │
           ┌──────────────────┐          ┌──────────────────────┐
           │ DigitalOcean       │◀────────│ Callback Lambda        │
           │ droplet (OpenFOAM) │ ───────▶│ (separate auth/trust)  │
           └──────────────────┘          └──────────────────────┘
```

Key properties preserved from the current design:

- **No always-on compute.** Every compute component (Lambdas, Step Functions,
  droplets) is pay-per-use. Only S3 + CloudFront are always "on," and both are
  effectively free at low traffic.
- **Heavy compute stays on DigitalOcean.** This migration does not change how or
  where OpenFOAM runs — only how its lifecycle is supervised.

---

## 3. Repository Structure

Stay in a single repository. Restructure folders so frontend and backend deploy
independently:

```
caucsim/
├── frontend/
│   ├── shared/           # common auth check, nav header, shared CSS tokens
│   ├── landing/           # new: app-picker landing page (default route)
│   ├── cfd/               # existing CFD UI (moved from public/)
│   ├── vehicle-sim/        # new: vehicle performance simulation UI
│   └── compare/            # new: results comparison/management UI
├── backend/
│   ├── app/                 # shared Lambda: CFD + vehicle-sim routed handlers
│   │   ├── cfd/               # CFD job endpoint handlers
│   │   └── vehicle-sim/        # vehicle performance simulation handlers
│   ├── results/             # new Lambda: shared results index API
│   ├── callback/            # new Lambda: droplet callback receiver (separate trust boundary)
│   ├── statemachine/        # Step Functions definition (ASL JSON) + supporting Lambdas
│   └── serverless.yaml      # updated to define multiple functions
├── infra/
│   └── cloudfront/          # CloudFront distribution config (CDK/Terraform/console notes)
└── .github/workflows/
    ├── deploy-frontend.yml  # triggers on changes under frontend/
    └── deploy-backend.yml   # triggers on changes under backend/
```

### CI requirements

- `deploy-frontend.yml`: triggered by `paths: ['frontend/**']`. Syncs each
  `frontend/<ui>/` folder to its corresponding S3 prefix, then issues a
  CloudFront invalidation for the affected path(s) only.
- `deploy-backend.yml`: triggered by `paths: ['backend/**']`. Runs
  `serverless deploy`. Ensure `serverless.yaml` package patterns explicitly
  exclude `frontend/` so it is never bundled into any Lambda zip.

---

## 4. CloudFront / Routing

Single CloudFront distribution, multiple origins:

| Path pattern      | Origin                              | Notes                                   |
|-------------------|--------------------------------------|------------------------------------------|
| `/cfd/*`          | S3 `frontend/cfd/`                   | existing CFD UI                          |
| `/vehicle-sim/*`  | S3 `frontend/vehicle-sim/`           | new UI                                   |
| `/compare/*`      | S3 `frontend/compare/`               | new UI                                   |
| `/api/*`          | API Gateway (execute-api endpoint)   | no separate custom domain needed on APIGW |
| `/*` (default)    | S3 `frontend/landing/`               | app-picker landing page (see below)      |

Requirements:

- TLS certificate for CloudFront **must** be issued in `us-east-1`, regardless
  of the region used for other infra (`eu-west-2`).
- `frontend/landing/` is a simple app-picker page: after auth, present links/
  cards to the CFD UI, Vehicle Performance UI, and Compare UI. It carries the
  same auth check as the other three UIs (login is enforced before showing
  the picker, not after selecting an app).
- All four frontend bundles (landing, cfd, vehicle-sim, compare) load a
  shared auth-check module from `frontend/shared/` so login state is
  enforced consistently and a single Cognito session covers all of them.
- Fix the current auth-flash issue while migrating: gate initial render behind
  the auth check (show a lightweight loading state, resolve the token check,
  then render either login or the app) rather than rendering the app shell
  optimistically and swapping it out.

---

## 5. Authentication

- Move JWT validation from in-app Express middleware to a **Cognito JWT
  authorizer configured directly on API Gateway**. Remove `aws-jwt-verify`
  middleware from application code once this is confirmed working.
- The droplet callback endpoint (`backend/callback/`) is **not** behind the
  Cognito authorizer — it is called by an external, unauthenticated machine
  (the droplet), not a logged-in user. Secure it with a signed callback
  token (HMAC, verified in-function) generated per-job and passed to the
  droplet at boot.

---

## 6. Shared Data Model: Results Index

A single DynamoDB table backs cross-domain listing/comparison. This is the
contract that makes the Compare UI possible — build this first.

**Table: `ResultsIndex`**

Partition key: `jobId` (string, UUID)
GSI: `userId-createdAt-index` (partition: `userId`, sort: `createdAt`)
GSI: `userId-type-index` (partition: `userId`, sort: `type`) — for filtering by domain

```jsonc
{
  "jobId": "abc123",
  "userId": "cognito-sub-value",
  "type": "cfd" | "vehicle_sim",
  "status": "queued" | "running" | "complete" | "failed",
  "createdAt": "2026-07-30T12:00:00Z",
  "completedAt": "2026-07-30T12:14:00Z",
  "resultsS3Prefix": "results/abc123/",
  "displayName": "F24-v3 baseline",
  "notes": "",

  // present only when type == "cfd"
  "aeroSummary": {
    "frontalArea": 1.14,
    "dragCoefficient": 0.31,
    "computedAtSpeedMph": 30
  },

  // present only when type == "vehicle_sim"
  "vehicleSimSummary": {
    "inputs": {
      "dragCoefficient": 0.31,
      "frontalArea": 1.14,
      "mass": 95,
      "batteryCapacityWh": 1200
    },
    "sourceCfdJobId": "abc123-or-null",
    "results": {
      "distanceKm": 42.3,
      "raceDurationMin": 38,
      "batteryDepletion": 0.91
    }
  }
}
```

Rules:

- `aeroSummary` is written by the CFD pipeline at job completion (see Section 7).
- `vehicleSimSummary` is written synchronously when a user explicitly saves a
  vehicle-sim run (see Section 8) — not on every simulation invocation.
- `sourceCfdJobId` must be recorded whenever a vehicle-sim run's Cd/A values
  were populated from a CFD run, even if the user subsequently edited them.
  Set to `null` if values were entered manually. This lineage field is
  required, not optional — do not skip it to save time, since retrofitting it
  onto historical records later is costly.
- `notes` is a required field on every `ResultsIndex` record (default: empty
  string), free-text, user-editable at any time via the Compare UI (Section
  9) independent of job status. It is not written by the CFD or vehicle-sim
  pipelines themselves — only by the user, via a dedicated update endpoint.

---

## 7. CFD Domain Changes

Existing CFD job logic (droplet launch, S3 case template patching, results
processing) is preserved. Required changes:

1. **Compute and persist `aeroSummary` at job completion.**
   Derive drag coefficient from existing force output and frontal area:

   ```
   Cd = dragForce / (0.5 * airDensity * velocity^2 * frontalArea)
   ```

   Write `aeroSummary.frontalArea`, `aeroSummary.dragCoefficient`, and
   `aeroSummary.computedAtSpeedMph` (the race speed the run was solved at) to
   the `ResultsIndex` record for that job. Do this as part of existing results
   processing — do not require a separate read of `results.zip` by consumers.

2. **Write a `ResultsIndex` record at job creation and update it through the
   job lifecycle** (`status` transitions: `queued` → `running` → `complete`/
   `failed`), rather than tracking job state only in module-level memory or
   solely in job-specific storage. This is required for both the Compare UI
   and for Step Functions migration (Section 9) to have a durable state to
   read/write against.

3. **Split the API surface:**
   - `POST /api/cfd/jobs` — create job (presign upload URLs, kick off Step
     Functions execution)
   - `GET /api/cfd/jobs/:id` — job status
   - `GET /api/cfd/jobs/:id/results` — presigned URLs for result artifacts

---

## 8. Vehicle Performance Simulation (New)

A new domain. No HPC compute required — this runs synchronously inside a
single Lambda invocation.

**Endpoints (`backend/vehicle-sim/`):**

- `POST /api/vehicle/simulate` — runs the simulation synchronously given
  inputs, returns full results in the response. No job-status polling, no
  `ResultsIndex` write on this call alone (this is a "try it" / preview call).
- `POST /api/vehicle/save` — persists a simulation (inputs + results) that the
  user has explicitly chosen to keep. This is what writes the
  `vehicleSimSummary` record to `ResultsIndex`.
- `GET /api/vehicle/runs/:id` — retrieve a saved run.

**Inputs (minimum viable set — extend as needed):**

- `dragCoefficient` (number)
- `frontalArea` (number, m²)
- `mass` (number, kg)
- `batteryCapacityWh` (number)
- Track/course profile parameters (TBD — confirm with existing race
  regulations/spec docs under `Specifications/`)

**Outputs (minimum viable set):**

- Distance traveled over race duration
- Battery state-of-charge over time (time series, for charting)
- Estimated race completion time / whether the vehicle finishes within
  battery capacity

**Sizing note:** confirm actual wall-clock execution time under realistic
inputs before finalizing Lambda memory/timeout config. If a run consistently
takes more than a few seconds, increase memory (which also increases CPU
allocation) rather than assuming external compute is needed — this simulation
does not require HPC-grade compute per prior analysis.

**CFD data pull-through (required feature, not optional):**

The vehicle-sim UI must let a user select a completed CFD run from a dropdown
(populated via `GET /api/results?type=cfd&status=complete`, reading
`aeroSummary` off each record) to auto-fill `dragCoefficient` and
`frontalArea`. These fields must remain user-editable after being populated
this way — do not lock them. When the user selects a source CFD run,
capture its `jobId` and store it in `sourceCfdJobId` on save (Section 6).

---

## 9. Results / Comparison Domain (New)

**Endpoints (`backend/results/`):**

- `GET /api/results?type=cfd|vehicle_sim&status=...` — list results for the
  current user, filtered/sorted via the `userId-createdAt-index` or
  `userId-type-index` GSI. Used by both the vehicle-sim source picker and the
  Compare UI.
- `GET /api/results/:jobId` — full detail for a single result (fetches
  `ResultsIndex` record; for CFD, may also generate fresh presigned URLs for
  artifacts under `resultsS3Prefix`).
- `PATCH /api/results/:jobId` — update user-editable metadata only
  (`displayName`, `notes`). Must verify the requesting user owns the record
  before allowing the update.

**Compare UI (`frontend/compare/`):**

- List/browse all of a user's CFD and vehicle-sim runs.
- Side-by-side comparison view for two or more runs (same type).
- For vehicle-sim runs, surface `sourceCfdJobId` as a link back to the
  originating CFD run when present, so provenance is visible, not just the
  copied numbers.
- Basic documentation/annotation: allow a user to set/edit `displayName` and
  `notes` (free text) on any run, via `PATCH /api/results/:jobId`.

---

## 10. Orchestration: Step Functions Migration

Replace the current bash-based lifecycle (callback hooks patched into
`Allrun`, background `sleep 3600` self-destruct) with a Step Functions state
machine (`backend/statemachine/`).

**States (indicative — refine against actual current phase names: Standby,
Queued, Initializing, Meshing, Solving, Processing):**

1. `CreateDroplet` — Lambda task, calls DigitalOcean API (same call as today).
2. `WaitForMeshing` — `waitForTaskToken` pattern; droplet calls back via the
   Callback Lambda (Section 11) to resume this state. Timeout: ~20 min
   (tune against real observed durations).
3. `WaitForSolving` — same pattern. Timeout: ~30 min.
4. `ConfirmResults` — Lambda task, verifies `results.zip` (and streamlines
   assets, if present) landed in S3.
5. `DestroyDroplet` — runs in a `Finally`/`Catch` block so it executes
   regardless of success, failure, or timeout at any prior state. This
   replaces the `sleep 3600` self-destruct as the primary safety net; the
   in-droplet self-destruct may be retained as a redundant last-resort
   backup but should no longer be the *only* safety net.

**Requirements:**

- Every wait state must have an explicit timeout shorter than the current
  1-hour ceiling, since the goal is faster failure detection, not just an
  equivalent one.
- Each state transition should update the corresponding `ResultsIndex`
  record's `status` field, so job status polling (`GET /api/cfd/jobs/:id`)
  can read from `ResultsIndex` directly rather than querying Step Functions
  execution state.
- Preserve existing droplet-side behavior not related to lifecycle
  supervision: case template patching, meshing/solving commands, streamlines
  generation via `pvpython`/`xvfb-run` (with graceful skip if unavailable).

---

## 11. Callback Lambda (New, Separate Trust Boundary)

`backend/callback/` — receives HTTP callbacks from the droplet during
meshing/solving phases.

- **Not** behind the Cognito authorizer (the caller is a droplet, not a
  logged-in user).
- Authenticate via a per-job signed token, generated when the job/droplet is
  created and passed to the droplet at boot (e.g. via `APP_CALLBACK_URL` plus
  a token parameter). Verify the token's signature and job association before
  acting on any callback.
- On receiving a valid callback, calls
  `SendTaskSuccess`/`SendTaskFailure`/`SendTaskHeartbeat` against the Step
  Functions execution's task token to resume the corresponding wait state.
- Its IAM role should be scoped narrowly: permission to interact with Step
  Functions task tokens, nothing else. It should not share the CFD jobs
  Lambda's broader role (S3 read/write, DigitalOcean token, etc.).

---

## 12. Migration Sequencing

Recommended order, each step independently shippable and testable:

1. Restructure the repository into `frontend/`/`backend/` folders (no
   behavior change yet — pure reorg + updated build/deploy scripts).
2. Stand up S3 + CloudFront for the existing CFD frontend only, verify via
   CloudFront's own `*.cloudfront.net` test domain before touching DNS.
3. Add the `/api/*` CloudFront behavior pointing at the existing API
   Gateway/Lambda; verify end-to-end against the CloudFront test domain.
4. Cut DNS over to CloudFront.
5. Move Cognito JWT validation from in-app middleware to the API Gateway
   authorizer; remove the old middleware once confirmed.
6. Introduce the `ResultsIndex` DynamoDB table; update the existing CFD job
   pipeline to write/update records through the job lifecycle, including the
   new `aeroSummary` computation at completion.
7. Build the Step Functions state machine and Callback Lambda; cut the CFD
   droplet orchestration over from bash/`sleep`-based supervision. Keep the
   in-droplet self-destruct as a backup during transition.
8. Build the vehicle-sim Lambda + UI, including the CFD pull-through feature
   and `sourceCfdJobId` lineage.
9. Build the results/compare Lambda + UI.

Each of steps 2–9 should be deployable and verifiable independently; avoid
batching multiple steps into one release.

---

## 13. Decisions

The following were open questions in earlier drafts of this spec and have
since been resolved:

- **Default route (`/`):** build a dedicated landing/app-picker page
  (`frontend/landing/`, Section 4), not a redirect to `/cfd/`. See Section 4
  for its auth requirements.
- **Vehicle performance model:** intentionally left undefined at this stage.
  `POST /api/vehicle/simulate` and `POST /api/vehicle/save` (Section 8) should
  be implemented against the input/output shapes given as a minimum viable
  set, but the actual simulation logic (point-mass energy balance vs. a more
  detailed model, exact track/course parameters) is a placeholder to be
  designed and supplied later. Do not treat the example inputs/outputs in
  Section 8 as final — treat them as a contract stub pending that design.
- **CFD and vehicle-sim Lambda structure:** implemented as **one shared
  Lambda function** with routed handlers for both domains (see the
  `backend/app/` structure in Section 3), not two separate functions. Route
  by path prefix (`/api/cfd/*` vs `/api/vehicle/*`) within the same handler,
  the way the current single-function app already routes internally.
- **`notes` field on `ResultsIndex`:** added now, not deferred (see Section 6
  and the `PATCH /api/results/:jobId` endpoint in Section 9).
