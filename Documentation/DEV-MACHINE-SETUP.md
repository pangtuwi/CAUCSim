# Development Machine Setup

How to get a new Mac from nothing to running CAUCSim locally, deploying the backend,
and applying the CloudFront infrastructure. Follow it top to bottom on a fresh
machine; individual sections stand alone if you only need one tool back.

Verified on macOS 15.7.7, Apple Silicon (`arm64`), July 2026.

---

## 0. Versions this project is known to work with

| Tool | Version in use | Install route |
|---|---|---|
| macOS | 15.7.7 (arm64) | — |
| Homebrew | 6.0.9 | `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"` |
| Git | 2.54.0 | Xcode CLT or `brew install git` |
| Node.js | 24.16.0 | nvm |
| npm | 12.0.1 | ships with Node |
| AWS CLI | 2.36.13 | `brew install awscli` |
| Terraform | 1.15.8 | `brew install hashicorp/tap/terraform` |
| Serverless Framework | v3 (via `npx`) | not installed globally |
| Google Chrome | current | required for local testing (see §7) |

Nothing here pins to an exact patch version — these are what the project has been
exercised against, useful when something behaves unexpectedly on a new machine.

---

## 1. Homebrew

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

On Apple Silicon Homebrew installs to `/opt/homebrew`, and the installer prints two
`eval` lines to add it to your `PATH`. Run them, then confirm:

```bash
brew --version
which brew        # expect /opt/homebrew/bin/brew
```

If `brew` is found at `/usr/local/bin/brew` on an Apple Silicon Mac, you are in an
Intel/Rosetta shell — that works but installs x86 binaries. Prefer the native path.

---

## 2. Node.js via nvm

The project uses nvm rather than Homebrew's Node, so the version can move per-project.

```bash
brew install nvm
mkdir -p ~/.nvm
```

Add to `~/.zshrc` (Homebrew prints the exact lines):

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && \. "/opt/homebrew/opt/nvm/nvm.sh"
[ -s "/opt/homebrew/opt/nvm/etc/bash_completion.d/nvm" ] && \. "/opt/homebrew/opt/nvm/etc/bash_completion.d/nvm"
```

Open a new shell, then:

```bash
nvm install 24
nvm use 24
node --version    # v24.x
```

Note the CI workflow (`.github/workflows/deploy.yml`) builds on Node 22 while the
Lambda runtime is `nodejs20.x` (`serverless.yaml`). Local Node 24 is fine — nothing
in the app uses APIs newer than 20 — but if you hit a runtime-only failure, that
version spread is the first thing to check.

---

## 3. Clone and install

```bash
git clone git@github.com:pangtuwi/CAUCSim.git
cd CAUCSim
npm install
```

Verify without needing any AWS access:

```bash
npm test         # 46 tests across 3 suites; all AWS calls are mocked
```

---

## 4. Environment file

```bash
cp .env.example .env
```

Then fill it in. **The values are not in this repository and must not be committed** —
`.env` is gitignored, and `serverless.yaml` excludes it from the Lambda bundle.
Sources for each value:

| Variable | Where it comes from |
|---|---|
| `S3_BUCKET_NAME`, `AWS_REGION` | `AWSCONFIG.md` §3 |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | IAM user `cauc-local-dev-user` — issue a **new** access key in the IAM console rather than copying one off the old machine, and delete the old key once the new machine works |
| `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID` | `AWSCONFIG.md` §4 (not secret) |
| `DIGITALOCEAN_TOKEN` | DigitalOcean console → API → Tokens; generate a new one |
| `DIGITALOCEAN_PROJECT_ID`, `DIGITALOCEAN_REGION`, `DIGITALOCEAN_SIZE` | defaults in `.env.example` are current |
| `DIGITALOCEAN_SSH_KEY_FP` | `doctl compute ssh-key list`, or the DO console |
| `DIGITALOCEAN_SNAPSHOT_NAME` | `SETUP_DROPLET.md` — must name a snapshot with ParaView + Xvfb |
| `APP_CALLBACK_URL` | the deployed API's public base URL |

Rotating keys when you change machines is the safer default: an access key sitting on
a decommissioned laptop is a live credential.

Confirm the app starts:

```bash
npm run dev
# → "AWS Cognito Authentication initialized." / "Server is running on port 3000"
```

---

## 5. AWS CLI

```bash
brew install awscli
aws --version
```

Configure a named profile — this is separate from `.env`, which the Node app reads:

```bash
aws configure --profile caucsim
# AWS Access Key ID / Secret / region eu-west-2 / output json
export AWS_PROFILE=caucsim          # add to ~/.zshrc to make it stick
aws sts get-caller-identity
```

Expect account `247638741223`. Credentials live in `~/.aws/credentials`; copying that
file from an old machine works but rotating the key is better practice.

---

## 6. Terraform

**Terraform is no longer in homebrew-core** — it was removed after HashiCorp moved to
the BUSL licence, so `brew install terraform` fails with "No available formula". Use
HashiCorp's own tap:

```bash
brew tap hashicorp/tap
brew install hashicorp/tap/terraform
terraform version
```

(`brew install opentofu` is the open-source fork and is drop-in compatible with this
configuration, if you would rather avoid the BUSL licence.)

Initialise the CloudFront workspace:

```bash
cd infra/cloudfront
cp terraform.tfvars.example terraform.tfvars   # gitignored
terraform init
terraform validate
```

`terraform init` downloads the AWS provider (~700 MB in `.terraform/`, gitignored) and
writes `.terraform.lock.hcl`, which **is** committed — it pins provider versions across
machines. State is local and gitignored, so on a new machine you will not have the
state for infrastructure created elsewhere. Options:

- If nothing has been applied yet: nothing to do.
- If it has: either move state to S3 (uncomment the `backend "s3"` block in
  `versions.tf`, then `terraform init -migrate-state` from the machine that holds the
  state), or copy `terraform.tfstate` across. **State can contain sensitive values —
  never commit it.**

See `CLOUDFRONT-SETUP.md` for the IAM permissions Terraform needs; the default
`cauc-local-dev-user` lacks CloudFront access and `terraform plan` fails on it.

---

## 7. Google Chrome

Local testing happens in Chrome on `http://localhost:3000`, because the app is gated
behind Cognito and the signed-in session lives in the browser profile (see `CLAUDE.md`
and `AGENTS.md` §5). Install Chrome and sign in to the app once before asking an agent
to verify anything.

---

## 8. Optional tools

```bash
brew install jq          # used throughout the runbooks for reading JSON responses
brew install doctl       # DigitalOcean CLI — droplet/snapshot management (SETUP_DROPLET.md)
brew install --cask visual-studio-code
```

`doctl` needs `doctl auth init` with the same token as `DIGITALOCEAN_TOKEN`.

The Serverless Framework is deliberately **not** installed globally — deploys run
through the GitHub Action, and local packaging uses `npx serverless@3 package`.

---

## 9. Verification checklist

Work down this list; each line either passes or tells you which section to revisit.

```bash
node --version                  # v24.x                          → §2
npm test                        # 46 passed                      → §3
npm run dev                     # starts on :3000                → §4
aws sts get-caller-identity     # account 247638741223           → §5
terraform -chdir=infra/cloudfront validate   # Success!          → §6
```

Then open `http://localhost:3000` in Chrome, sign in, and confirm the CAD model list
populates — that exercises the whole path: `.env` → Express → Cognito → S3.

---

## 10. Known gotchas

- **`brew install terraform` fails.** Expected; use the HashiCorp tap (§6).
- **`node --watch` does not recover from a moved entry file.** If you moved or renamed
  files, restart it — it will otherwise sit retrying a path that no longer exists.
- **`serverless package` run locally drops `node_modules`** from the zip in this
  working directory (its dev-dependency exclusion misfires against modern npm). CI
  deploys correctly because it installs with `npm ci --only=production`; do not deploy
  a locally built package without checking the zip contents first.
- **Two AWS credential paths.** `.env` feeds the Node app; `~/.aws/credentials` feeds
  the CLI and Terraform. Setting one does not configure the other.
