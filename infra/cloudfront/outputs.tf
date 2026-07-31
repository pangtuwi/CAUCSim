output "frontend_bucket" {
  description = "S3 bucket holding the static frontends."
  value       = aws_s3_bucket.frontend.id
}

output "cloudfront_domain_name" {
  description = "CloudFront test domain. Verify everything here before touching DNS."
  value       = "https://${aws_cloudfront_distribution.site.domain_name}"
}

output "distribution_id" {
  description = "Distribution ID, needed for cache invalidations."
  value       = aws_cloudfront_distribution.site.id
}

output "api_origin_domain" {
  description = "API Gateway origin behind /api/*, or a note when the behaviour is disabled."
  value       = var.enable_api_behavior ? "${data.aws_api_gateway_rest_api.backend[0].id}.execute-api.${var.region}.amazonaws.com/${var.api_gateway_stage}" : "disabled (set enable_api_behavior = true)"
}

output "deploy_commands" {
  description = "Copy/paste to publish the CFD frontend and invalidate the edge cache."
  value       = <<-EOT
    aws s3 sync ../../frontend/cfd/ s3://${aws_s3_bucket.frontend.id}${var.frontend_origin_path}/ --delete --exclude "*.html" --cache-control "public, max-age=0, must-revalidate"
    aws s3 sync ../../frontend/cfd/ s3://${aws_s3_bucket.frontend.id}${var.frontend_origin_path}/ --delete --exclude "*" --include "*.html" --cache-control "no-cache, no-store, must-revalidate"
    aws cloudfront create-invalidation --distribution-id ${aws_cloudfront_distribution.site.id} --paths "/*"
  EOT
}
