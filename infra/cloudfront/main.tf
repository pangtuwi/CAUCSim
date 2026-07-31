data "aws_caller_identity" "current" {}

locals {
  bucket_name = var.frontend_bucket_name != "" ? var.frontend_bucket_name : "${var.project}-frontend-${data.aws_caller_identity.current.account_id}-${var.region}"

  s3_origin_id  = "s3-frontend"
  api_origin_id = "apigw-backend"
}

# ---------------------------------------------------------------------------
# S3: private origin bucket for the static frontends
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "frontend" {
  bucket = local.bucket_name
  tags   = var.tags
}

# No public access at any level — CloudFront reads via Origin Access Control,
# so the bucket itself never needs to be reachable from the internet.
resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Keeps the previous build of every file, so a bad deploy can be rolled back by
# restoring versions rather than re-running a pipeline.
resource "aws_s3_bucket_versioning" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Old non-current versions are dead weight after a few deploys.
resource "aws_s3_bucket_lifecycle_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  policy = data.aws_iam_policy_document.frontend_bucket.json
}

data "aws_iam_policy_document" "frontend_bucket" {
  statement {
    sid     = "AllowCloudFrontRead"
    actions = ["s3:GetObject"]
    effect  = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    resources = ["${aws_s3_bucket.frontend.arn}/*"]

    # Scopes the grant to THIS distribution — without it any CloudFront
    # distribution in any account could read the bucket.
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.site.arn]
    }
  }
}

# ---------------------------------------------------------------------------
# CloudFront
# ---------------------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${var.project}-frontend-oac"
  description                       = "SigV4 access from CloudFront to the ${local.bucket_name} bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# AWS-managed policies. Referencing them by name keeps the config short and
# means AWS maintains the header/TTL details.
data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

# Forwards every viewer header EXCEPT Host. Host must not be forwarded to
# API Gateway — execute-api routes on the Host header and rejects a foreign one.
# Authorization, cookies and query strings all pass through, which is what the
# Cognito-authenticated API calls need.
data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

data "aws_cloudfront_response_headers_policy" "security_headers" {
  name = "Managed-SecurityHeadersPolicy"
}

data "aws_api_gateway_rest_api" "backend" {
  count = var.enable_api_behavior ? 1 : 0
  name  = var.api_gateway_name
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "${var.project} — static frontends + /api passthrough"
  default_root_object = "index.html"
  price_class         = var.price_class
  http_version        = "http2and3"
  aliases             = var.domain_names
  tags                = var.tags

  origin {
    origin_id                = local.s3_origin_id
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
    origin_path              = var.frontend_origin_path
  }

  dynamic "origin" {
    for_each = var.enable_api_behavior ? [1] : []

    content {
      origin_id   = local.api_origin_id
      domain_name = "${data.aws_api_gateway_rest_api.backend[0].id}.execute-api.${var.region}.amazonaws.com"
      origin_path = "/${var.api_gateway_stage}"

      custom_origin_config {
        http_port                = 80
        https_port               = 443
        origin_protocol_policy   = "https-only"
        origin_ssl_protocols     = ["TLSv1.2"]
        origin_keepalive_timeout = 5
        # Job creation calls the DigitalOcean API before responding; 60s is the
        # maximum CloudFront allows without a service quota increase.
        origin_read_timeout = 60
      }
    }
  }

  # Static assets. CachingOptimized honours the Cache-Control headers set on the
  # objects at upload time, so index.html stays revalidated while assets are
  # served from the edge (see the sync commands in the runbook).
  default_cache_behavior {
    target_origin_id           = local.s3_origin_id
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security_headers.id
  }

  # API passthrough. Never cached: these responses are per-user and the Express
  # app already sends no-store headers on /api.
  dynamic "ordered_cache_behavior" {
    for_each = var.enable_api_behavior ? [1] : []

    content {
      path_pattern             = "/api/*"
      target_origin_id         = local.api_origin_id
      viewer_protocol_policy   = "https-only"
      allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
      cached_methods           = ["GET", "HEAD"]
      compress                 = true
      cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
      origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = var.acm_certificate_arn == ""
    acm_certificate_arn            = var.acm_certificate_arn != "" ? var.acm_certificate_arn : null
    ssl_support_method             = var.acm_certificate_arn != "" ? "sni-only" : null
    minimum_protocol_version       = var.acm_certificate_arn != "" ? "TLSv1.2_2021" : null
  }
}
