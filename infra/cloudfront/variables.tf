variable "project" {
  description = "Name prefix applied to created resources."
  type        = string
  default     = "caucsim"
}

variable "region" {
  description = "Region for the S3 frontend bucket and the API Gateway origin. Must match the region the backend Lambda is deployed to."
  type        = string
  default     = "eu-west-2"
}

variable "frontend_bucket_name" {
  description = "Name of the S3 bucket holding the static frontends. Leave empty to derive one as caucsim-frontend-<account-id>-<region>. Must be globally unique."
  type        = string
  default     = ""
}

variable "frontend_origin_path" {
  description = <<-EOT
    Prefix inside the bucket that the DEFAULT behaviour serves from. Set to
    "/cfd" so the CFD UI lives at s3://<bucket>/cfd/ from day one — that is the
    layout the migration spec targets, so adding the landing/vehicle-sim/compare
    UIs later is a new behaviour rather than a re-shuffle of existing objects.
  EOT
  type        = string
  default     = "/cfd"
}

variable "enable_api_behavior" {
  description = <<-EOT
    Whether to add the /api/* behaviour pointing at the existing API Gateway.
    Start with false to verify static hosting on its own (migration step 2),
    then flip to true and re-apply (migration step 3). With this false the UI
    loads but every API call 403s — that is expected, not a fault.
  EOT
  type        = bool
  default     = false
}

variable "api_gateway_name" {
  description = "Name of the existing REST API created by serverless. Default follows the serverless naming convention of <stage>-<service>. Confirm with: aws apigateway get-rest-apis --region eu-west-2 --query 'items[].name'"
  type        = string
  default     = "prod-caucsim-backend"
}

variable "api_gateway_stage" {
  description = "Deployment stage of the REST API. Matches provider.stage in serverless.yaml."
  type        = string
  default     = "prod"
}

variable "price_class" {
  description = "CloudFront price class. PriceClass_100 (North America + Europe) is the cheapest and covers the UK user base."
  type        = string
  default     = "PriceClass_100"

  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.price_class)
    error_message = "price_class must be PriceClass_100, PriceClass_200 or PriceClass_All."
  }
}

variable "domain_names" {
  description = "Custom domains to serve the distribution on (migration step 4). Leave empty to use the *.cloudfront.net domain only. Requires acm_certificate_arn when set."
  type        = list(string)
  default     = []
}

variable "acm_certificate_arn" {
  description = "ARN of an ACM certificate covering domain_names. MUST be issued in us-east-1. Leave empty while using the *.cloudfront.net domain."
  type        = string
  default     = ""

  validation {
    condition     = var.acm_certificate_arn == "" || can(regex("^arn:aws:acm:us-east-1:", var.acm_certificate_arn))
    error_message = "CloudFront only accepts certificates from us-east-1."
  }
}

variable "tags" {
  description = "Tags applied to every taggable resource."
  type        = map(string)
  default = {
    Project   = "CAUCSim"
    ManagedBy = "Terraform"
  }
}
