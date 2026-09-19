# CAUCSim Admin

A separate web app for administering CAUCSim's data: who has an account, every
simulation anyone has run, and every `.stl` in the bucket — with download and
delete for both.

It exists because the CFD app deliberately cannot show you this. `GET /api/jobs`
hides any run whose `jobData.userSub` is someone else's, so no account —
including yours — can see another user's runs. Until now the only way to see the whole picture was
the S3 console.

Runs locally on **port 3001** against real AWS. It exports a `serverless-http`
handler and ships a `serverless.yaml`, but it is not deployed by default.

---

## Setup

### 1. Create the Cognito group

The pool has no groups at all today — every account has identical privileges.
Create one and put yourself in it:

```bash
aws cognito-idp create-group --region eu-west-2 \
  --user-pool-id eu-west-2_ft1OVuuU1 \
  --group-name admins --description "CAUCSim administrators" --precedence 0

# The pool signs in by email, so Username is a generated UUID. Look yours up:
aws cognito-idp list-users --region eu-west-2 \
  --user-pool-id eu-west-2_ft1OVuuU1 \
  --filter 'email = "you@example.com"' \
  --query 'Users[].Username' --output text

aws cognito-idp admin-add-user-to-group --region eu-west-2 \
  --user-pool-id eu-west-2_ft1OVuuU1 \
  --username '<UUID-from-above>' --group-name admins
```

> **Sign out and back in afterwards.** Group membership is written into the ID
> token when you sign in, so a token issued before you joined the group has no
> `cognito:groups` claim and will keep being refused. This looks exactly like a
> bug and is not one — the app says so on the "not an administrator" screen.
>
> The reverse also holds: removing someone from the group does not take effect
> until their token expires (one hour). To cut access immediately, disable the
> Cognito account.

### 2. IAM

The credentials in the repo-root `.env` need, in addition to the existing
`caucsim-s3-access` policy:

```
cognito-idp:ListUsers
cognito-idp:ListGroups
cognito-idp:ListUsersInGroup
```

on `arn:aws:cognito-idp:eu-west-2:<account>:userpool/eu-west-2_ft1OVuuU1`.

Without them everything still works except the Users page, which says so rather
than failing silently. **No IAM change is needed for deletes** — the existing
policy already grants `s3:DeleteObject` and `s3:ListBucket`.

### 3. Install and run

```bash
npm install --prefix admin
npm run admin            # or: cd admin && npm start
```

Then open <http://localhost:3001> and sign in with your normal CAUCSim account.

Configuration comes from the repo-root `.env` (bucket, region, credentials,
Cognito ids — shared with the CFD app). Admin-only settings go in `admin/.env`;
copy `admin/.env.example` to start. Note the load order in `lib/config.js`:
`admin/.env` is read **first** so its values win, because dotenv never
overwrites a variable that is already set.

The CFD dev server owns port 3000, so both can run at once.

---

## What it shows

### Simulations

Every run in `results/`, from every account: status, user, duration, Cd/Cl, size.
Click a row for the full record, the parameters, the metrics, the list of objects
in its prefix, and the log.

Download gives a presigned URL for `results.zip` or any individual artifact —
except `job.json`, which the app serves itself from a stripped copy. A presigned
URL would serve the *raw* object, and that still contains `jobToken`, the secret
the simulation droplet uses to authenticate its status callbacks.

Deleting removes every key under `results/<jobId>/`, after you type the job id.
**A `queued` or `running` job cannot be deleted, and there is no override.** The
droplet writes into that prefix itself on a loop, so it would simply reappear
half-formed — and deleting the record does not stop the droplet, which keeps
billing at `gd-16vcpu-64gb` with nothing left pointing at it. Stop the run in the
CFD app first.

### CAD files

Every `.stl` in `uploads/`. Ownership is the interesting part, because uploads
carry none of their own: the browser PUTs straight to S3 via a presigned URL, so
the only principal S3 ever sees is the CFD Lambda's role.

Three states, and the difference between them is a difference in the strength of
the claim:

| Shown as | Means |
| --- | --- |
| **uploaded by** | An upload record exists under `uploads-meta/`. Authoritative. |
| **first simulated by** | No record; inferred from the runs that used this file. A good proxy, not the same claim. |
| **no runs** | No record and never simulated. **The uploader is not recoverable.** |

That last row is a real limit, not a loading failure. S3 access logging and
CloudTrail don't help — they record the Lambda's role, not the person. The
`uploads-meta/` records fix it going forward only.

Separately from attribution, the "never simulated only" filter and the
reclaimable-bytes figure list every file no run references — whichever of the
three states it is in. That is your cleanup list.

Two reconciliation sections appear when relevant: runs referencing geometry that
is no longer in the bucket, and upload records whose upload never completed
(someone opened the file picker and cancelled).

### Users

Every account in the pool, with a single derived state — Active, Invited,
Disabled, Reset required — instead of Cognito's separate `Enabled` boolean and
`UserStatus` string. Enriched with each account's simulation count and last run.

> **Cognito does not record sign-ins.** `UserLastModifiedDate` moves on password
> and attribute changes, not on authentication, so it is shown as "Attributes
> changed" and never as a login time. "Last run", taken from simulation records,
> is the only genuine activity signal that exists. Getting true last-login would
> need Cognito Advanced Security or CloudTrail.

This view is **read only**. Inviting, disabling, resetting and deleting accounts
stay in the AWS CLI — see [USER_MANAGEMENT.md](../Documentation/USER_MANAGEMENT.md).
There is no `AdminDeleteUser` code path here at all, so no bug in this app can
destroy an account.

Simulations that no account claims are gathered into synthetic rows so the
counts here reconcile with the simulations page instead of quietly disagreeing.
There are two, because they mean different things: **Deleted user** holds runs
whose `userSub`/`userEmail` matches nobody in the pool; **No user recorded**
holds runs written before the CFD app captured identity in `job.json` at all
(September 2026). Note that the CFD app's ownership filter only applies when
`userSub` is present, so that second bucket is visible to every signed-in user
in the CFD app.

---

## Safety

- Deletes are permanent and there is **no undo**. S3 versioning on the bucket is
  the only thing that would provide one; it is not enabled, which is a
  deliberate choice consistent with "hard delete", but worth revisiting.
- Every delete requires typing the item's identifier. A file still referenced by
  simulations must be confirmed with its full S3 key, not just its name. The
  server re-checks — the dialog is the usability half, not the control.
- `jobToken` is stripped once, centrally, before anything is cached or returned.
- Every destructive action, every refusal, every presigned URL handed out, and
  every 403 is written to stdout as a JSON line (`"type":"admin-audit"`) — the
  terminal locally, CloudWatch under Lambda. Set `ADMIN_AUDIT_S3=true` to also
  write one object per action under `admin-audit/`.
- Locally the server binds to `127.0.0.1` only.

---

## Development

```bash
npm run dev --prefix admin     # watch mode
npm test --prefix admin        # or, from the root: npm run admin:test
```

Tests live in `admin/` rather than at the repo root like the rest of the
project's suites. `jest.mock()` resolves module paths relative to the file that
calls it, and this app's AWS SDK lives in `admin/node_modules` — a root-level
test would register its mocks against the wrong copy. The root `package.json`
therefore ignores this directory, and `npm run admin:test` runs it.

Layout:

```
app.js            Express app; listens when run directly, exports a Lambda handler
lib/config.js     env loading and validation
lib/auth.js       requireAdmin — verify the token, then check the group
lib/s3.js         paginated listing, batched deletes, key validation, presigning
lib/jobs.js       the shared results/ scan, its cache, and the jobToken strip
lib/uploads.js    the uploads/ view and its attribution logic
lib/users.js      Cognito listing and the derived account state
lib/audit.js      the audit trail
routes/           one module per resource
public/           vanilla HTML/CSS/JS, no build step
```

Everything paginates. The CFD backend's `GET /api/jobs` and `GET /api/files`
call `ListObjectsV2Command` without a continuation loop, which silently caps at
1000 keys — at roughly 11 keys per completed job, users start losing their own
history somewhere around job 90. This app does not copy that, and will make the
discrepancy visible. Fixing `backend/app/app.js` is worth doing separately.

## Deployment

Not deployed. `serverless.yaml` is written and validates, so `cd admin && npx
serverless deploy` works, but it is a deliberate manual step and is not in the
GitHub Actions workflow.

If you do deploy it, put CloudFront + WAF IP allow-listing in front. One Cognito
group claim is thin protection for a delete-everything endpoint on a public API
Gateway URL.
