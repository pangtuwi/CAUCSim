terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.60, < 7.0"
    }
  }

  # Local state is fine for a single operator. To share state across machines or
  # CI, uncomment and create the bucket + lock table first (see the runbook,
  # Documentation/CLOUDFRONT-SETUP.md, "Remote state").
  #
  # backend "s3" {
  #   bucket       = "caucsim-terraform-state-<account-id>"
  #   key          = "cloudfront/terraform.tfstate"
  #   region       = "eu-west-2"
  #   encrypt      = true
  #   use_lockfile = true
  # }
}

provider "aws" {
  region = var.region
}

# CloudFront ACM certificates must live in us-east-1, regardless of where the
# rest of the infrastructure runs. Only used once a custom domain is attached
# (migration step 4) — harmless before then.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}
