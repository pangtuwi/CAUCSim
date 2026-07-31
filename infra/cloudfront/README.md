# infra/cloudfront

Terraform for the CloudFront distribution that serves the static frontends and
proxies `/api/*` to the existing API Gateway.

Full runbook, verification steps and DNS cutover:
**`Documentation/CLOUDFRONT-SETUP.md`**.

```bash
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform apply                    # enable_api_behavior = false → static only
# verify the UI on the *.cloudfront.net domain, then:
# set enable_api_behavior = true and re-apply
terraform output -raw deploy_commands
```

| File | Purpose |
|---|---|
| `versions.tf` | Provider constraints, `eu-west-2` + `us-east-1` (ACM) providers, optional S3 backend |
| `variables.tf` | Inputs; the ones you will touch are `enable_api_behavior`, `domain_names`, `acm_certificate_arn` |
| `main.tf` | S3 origin bucket, OAC, bucket policy, distribution and behaviours |
| `outputs.tf` | Distribution domain/id, bucket name, ready-to-run sync + invalidation commands |

State is local and gitignored. Nothing here modifies the backend Lambda, API
Gateway, Cognito or the CAD storage bucket.
