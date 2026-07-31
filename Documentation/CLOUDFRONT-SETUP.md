# CloudFront Setup Runbook

Covers **steps 2–4** of `ARCHITECTURE-UPGRADE-SPEC.md`: standing up S3 + CloudFront
for the existing CFD frontend, adding the `/api/*` passthrough, and (later) cutting
DNS over. Terraform for all of it lives in `infra/cloudfront/`.

Nothing here changes the running app. CloudFront is **additive** until DNS moves —
the Lambda keeps serving the UI at its current URL throughout, so every phase below
is reversible by simply not using the new domain.

---

## What gets built

```
                 ┌──────────────────────────┐
  browser ──────▶│  CloudFront distribution   │
                 └───┬──────────────────┬────┘
                     │                  │
        default behaviour        /api/* behaviour
        (cached, S3 origin)      (never cached, APIGW origin)
                     │                  │
                     ▼                  ▼
        ┌──────────────────────┐  ┌────────────────────────┐
        │ S3 (private, OAC)    │  │ API Gateway → Lambda    │
        │ s3://<bucket>/cfd/   │  │ prod stage (unchanged)  │
        └──────────────────────┘  └────────────────────────┘
```

Three design points worth knowing before you run anything:

1. **The `/api/*` behaviour is not optional.** Every call in `frontend/cfd/js/main.js`
   is same-origin and relative (`fetch('/api/status')`, `/api/jobs/...`). Serve the
   UI from CloudFront without an API behaviour and the page renders but nothing works.
   That is exactly why the spec verifies static hosting first (phase B) and then adds
   the API (phase C) — you get a clean signal at each stage.
2. **`Host` must not be forwarded to API Gateway.** `execute-api` routes on the `Host`
   header and returns 403 for a foreign one. The Terraform uses the managed
   `AllViewerExceptHostHeader` origin request policy, which forwards `Authorization`,
   cookies and query strings but strips `Host`.
3. **Objects go under a `cfd/` prefix from the start.** The default behaviour has
   `origin_path = "/cfd"`, so `/` serves `s3://<bucket>/cfd/index.html` and the
   relative asset paths in `index.html` resolve normally. When the landing,
   vehicle-sim and compare UIs arrive they become sibling prefixes and new
   behaviours — no re-shuffling of existing objects.

### What does *not* need changing

- **Cognito.** Auth calls `cognito-idp.eu-west-2.amazonaws.com` directly from the
  browser with `USER_PASSWORD_AUTH`. There is no hosted UI and no callback URL list,
  so a new origin needs no Cognito configuration.
- **CAD bucket CORS.** Already `AllowedOrigins: ["*"]` (`AWSCONFIG.md` §3), so
  presigned direct-to-S3 uploads keep working from the CloudFront origin.
- **`APP_CALLBACK_URL`.** Droplets call the API directly. Leave it pointing at the
  existing endpoint; routing droplet callbacks through the CDN buys nothing.
- **The backend.** `serverless.yaml` and the Express static mount stay as they are
  until DNS has moved and the CloudFront path is proven.

---

## Prerequisites

Tooling install (including the Terraform-is-not-in-homebrew-core gotcha) is covered
in `DEV-MACHINE-SETUP.md`. Short version:

```bash
brew install awscli
brew tap hashicorp/tap && brew install hashicorp/tap/terraform
```

Configure credentials for the CAUCSim account (`247638741223`):

```bash
aws configure --profile caucsim
export AWS_PROFILE=caucsim
aws sts get-caller-identity
```

### IAM permissions — check this before Phase B

The existing `cauc-local-dev-user` has **no CloudFront permissions**. A `terraform
plan` run with those credentials fails immediately on the managed-policy lookups:

```
AccessDenied: User: arn:aws:iam::247638741223:user/cauc-local-dev-user is not
authorized to perform: cloudfront:ListCachePolicies
```

Attach the following to whichever principal runs Terraform (an inline policy on the
existing user, or a separate deployment user — the AWS managed `CloudFrontFullAccess`
plus `AmazonS3FullAccess` covers it too, more broadly than needed):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudFrontBuild",
      "Effect": "Allow",
      "Action": [
        "cloudfront:List*",
        "cloudfront:Get*",
        "cloudfront:CreateDistribution",
        "cloudfront:UpdateDistribution",
        "cloudfront:DeleteDistribution",
        "cloudfront:TagResource",
        "cloudfront:CreateOriginAccessControl",
        "cloudfront:UpdateOriginAccessControl",
        "cloudfront:DeleteOriginAccessControl",
        "cloudfront:CreateInvalidation"
      ],
      "Resource": "*"
    },
    {
      "Sid": "FrontendBucket",
      "Effect": "Allow",
      "Action": ["s3:CreateBucket", "s3:Get*", "s3:Put*", "s3:List*", "s3:DeleteObject"],
      "Resource": [
        "arn:aws:s3:::caucsim-frontend-*",
        "arn:aws:s3:::caucsim-frontend-*/*"
      ]
    },
    {
      "Sid": "LookUpApiGateway",
      "Effect": "Allow",
      "Action": ["apigateway:GET"],
      "Resource": "*"
    }
  ]
}
```

Re-run `terraform plan` until it completes without an `AccessDenied`. A plan creates
nothing, so it is a free permissions check.

---

## Phase A — initialise

```bash
cd infra/cloudfront
cp terraform.tfvars.example terraform.tfvars
terraform init
```

Confirm the REST API name Terraform will look up matches reality:

```bash
aws apigateway get-rest-apis --region eu-west-2 --query 'items[].{id:id,name:name}' --output table
```

`serverless` names it `<stage>-<service>`, so `prod-caucsim-backend` is expected. If
the name differs, set `api_gateway_name` in `terraform.tfvars`.

---

## Phase B — static hosting only (spec step 2)

`enable_api_behavior = false` in `terraform.tfvars`, then:

```bash
terraform apply
```

Expect ~10 resources and 3–5 minutes, most of it waiting for the distribution to
reach `Deployed`. Publish the CFD UI (the exact commands, with your bucket and
distribution id filled in, are in the `deploy_commands` output):

```bash
terraform output -raw deploy_commands
```

Two sync passes are used deliberately: HTML gets `no-cache, no-store,
must-revalidate` and everything else `public, max-age=0, must-revalidate` — the same
semantics the Express static mount serves today, so the CDN cannot serve a stale
`index.html` against a fresh `main.js`. Once assets carry content hashes in their
filenames, the second pass can move to `max-age=31536000, immutable`.

**Verify** against the CloudFront test domain (`terraform output cloudfront_domain_name`):

```bash
curl -sI https://dXXXXXXXX.cloudfront.net/ | head -20
```

- `HTTP/2 200` and `content-type: text/html`
- `x-cache: Hit from cloudfront` on a second request
- Open it in Chrome: the CFD shell renders, styles and fonts load, the version badge
  shows the current version
- **`/api/status` returns 403** — correct at this phase, the behaviour does not exist yet
- The login form appears but sign-in will not complete, because `/api/status` supplies
  the Cognito client config

Do not proceed until the static shell renders cleanly.

---

## Phase C — add the API passthrough (spec step 3)

Set `enable_api_behavior = true` in `terraform.tfvars`:

```bash
terraform apply
```

This adds one origin and one behaviour to the existing distribution; the S3 side is
untouched. Propagation is a few minutes.

**Verify**, still on the `*.cloudfront.net` domain:

```bash
curl -s https://dXXXXXXXX.cloudfront.net/api/status | jq
```

- Returns the JSON status payload with `bucketName`, `region` and the Cognito client id
- Response carries `cache-control: no-cache, no-store, must-revalidate` (the Express
  `/api` middleware, passed through uncached)

Then in Chrome, on the CloudFront domain:

1. Sign in — a successful login proves `Authorization` survives the hop
2. The CAD model list populates (`GET /api/files` with a bearer token)
3. Upload a small STL — proves presigned direct-to-S3 PUT works from the new origin
4. Open a completed job's results — proves the binary paths (`/download`,
   `/streamlines-model`, `/visualisation`) survive CloudFront, which is the most
   likely thing to misbehave given the API returns binary via
   `binaryMediaTypes: '*/*'`

If binary responses come back corrupted, the fix is at API Gateway, not CloudFront:
check that `binaryMediaTypes` still covers the content type being returned.

---

## Phase D — custom domain and DNS (spec step 4)

Only once phases B and C are fully verified.

1. Request a certificate **in us-east-1** (CloudFront reads certificates from there
   and nowhere else, regardless of `eu-west-2` for everything else):

   ```bash
   aws acm request-certificate \
     --region us-east-1 \
     --domain-name caucsim.example.org \
     --validation-method DNS
   ```

2. Add the CNAME validation record ACM returns to your DNS provider and wait for
   status `ISSUED`:

   ```bash
   aws acm describe-certificate --region us-east-1 --certificate-arn <arn> \
     --query 'Certificate.{Status:Status,Validation:DomainValidationOptions}'
   ```

3. Set `domain_names` and `acm_certificate_arn` in `terraform.tfvars`, then
   `terraform apply`. The variable validation will reject a non-us-east-1 ARN.

4. Point DNS at the distribution — an ALIAS/ANAME record (Route 53 alias, or a CNAME
   if the name is not the zone apex) to `dXXXXXXXX.cloudfront.net`. Lower the TTL a
   day beforehand so a rollback propagates quickly.

5. Verify on the real domain, then leave it running before proceeding with spec
   step 5 (moving JWT validation to an API Gateway authorizer).

**Rollback:** point DNS back at the previous endpoint. The Lambda is still serving
the full app, so nothing else needs reverting.

---

## Continuous deployment

Once the bucket exists, the frontend workflow from spec §3 becomes:

```yaml
name: Deploy frontend
on:
  push:
    branches: [main]
    paths: ['frontend/**']

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v5
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-region: eu-west-2
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
      - name: Sync CFD UI
        run: |
          aws s3 sync frontend/cfd/ s3://${{ secrets.FRONTEND_BUCKET }}/cfd/ --delete \
            --exclude "*.html" --cache-control "public, max-age=0, must-revalidate"
          aws s3 sync frontend/cfd/ s3://${{ secrets.FRONTEND_BUCKET }}/cfd/ --delete \
            --exclude "*" --include "*.html" --cache-control "no-cache, no-store, must-revalidate"
      - name: Invalidate CDN
        run: |
          aws cloudfront create-invalidation \
            --distribution-id ${{ secrets.CLOUDFRONT_DISTRIBUTION_ID }} --paths "/cfd/*" "/"
```

Do not add this workflow until the bucket exists, or every push to `main` fails.
The existing `deploy.yml` must keep running on frontend changes too until DNS has
moved, because the Lambda is still serving the UI on the live URL.

---

## Costs

At this traffic level effectively rounding error: S3 storage for ~1.6 MB of assets,
CloudFront's 1 TB/month free tier plus 1,000 free invalidation paths per month, and
no always-on compute. `PriceClass_100` (North America + Europe) keeps edge pricing at
the cheapest tier and covers the UK user base.

---

## Remote state

State is local by default, which is fine for one operator. To move it to S3, create
the bucket first, uncomment the `backend "s3"` block in `versions.tf`, then
`terraform init -migrate-state`.

---

## Console equivalent

If you would rather click through the console, these are the settings the Terraform
encodes:

| Setting | Value |
|---|---|
| S3 bucket | Block all public access **on**; versioning on; no static website hosting (OAC serves it) |
| Origin (static) | The bucket's **regional** domain, origin access **Origin access control**, origin path `/cfd` |
| Origin (API) | `<api-id>.execute-api.eu-west-2.amazonaws.com`, protocol **HTTPS only**, origin path `/prod` |
| Default behaviour | Cache policy `CachingOptimized`, response headers `SecurityHeadersPolicy`, viewer protocol **Redirect HTTP to HTTPS**, GET/HEAD/OPTIONS, compress on |
| `/api/*` behaviour | Cache policy `CachingDisabled`, origin request policy **AllViewerExceptHostHeader**, all HTTP methods, viewer protocol **HTTPS only** |
| Distribution | Default root object `index.html`, price class 100, HTTP/3 on |
| Bucket policy | Auto-generated by the console when you pick OAC — copy it into the bucket policy |
