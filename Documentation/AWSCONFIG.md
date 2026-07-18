# AWS Configuration Record - CAUCSim

This document provides a verified log of all live AWS resource configurations, naming conventions, and credentials associated with the CAUCSim deployment.

---

## 1. AWS Lambda Function & API Gateway
*   **Deployment Method:** Serverless Framework (`serverless.yaml`)
*   **Lambda Function Name:** `caucsim-backend-prod-api`
*   **Runtime Environment:** Node.js 20.x
*   **AWS Region:** `eu-west-2` (London)
*   **API Trigger:** AWS API Gateway (v1 REST API) proxying to the Express router
*   **Active Lambda Environment Variables:**
    *   `NODE_ENV`: `production` (disables all mock authentication overrides)
    *   `S3_BUCKET_NAME`: `cauc-cfd-storage-bucket-247638741223-eu-west-2-an`
    *   `AWS_REGION`: `eu-west-2`
    *   `COGNITO_USER_POOL_ID`: `eu-west-2_ft1OVuuU1`
    *   `COGNITO_CLIENT_ID`: `2i0abels4ntovsi3o4u5b0ni41`

---

## 2. AWS IAM Execution Role
*   **Lambda Execution Role Name:** `CAUCSim-role-nr6oiwxu`
*   **S3 Custom Access Policy Name:** `caucsim-s3-access` (attached to the role above)
*   **IAM Policy JSON:**
    ```json
    {
      "Version": "2012-10-17",
      "Statement": [
        {
          "Effect": "Allow",
          "Action": [
            "s3:PutObject",
            "s3:GetObject",
            "s3:DeleteObject"
          ],
          "Resource": "arn:aws:s3:::cauc-cfd-storage-bucket-247638741223-eu-west-2-an/*"
        },
        {
          "Effect": "Allow",
          "Action": [
            "s3:ListBucket"
          ],
          "Resource": "arn:aws:s3:::cauc-cfd-storage-bucket-247638741223-eu-west-2-an"
        }
      ]
    }
    ```

---

## 3. AWS S3 Storage Buckets
*   **CAD Storage Bucket Name:** `cauc-cfd-storage-bucket-247638741223-eu-west-2-an`
*   **Serverless Deployment Bucket Name:** `caucsim-backend-prod-serverlessdeploymentbucket-vcac0nuyz5v3`
*   **Public Access:** *Block all public access* is **Enabled**
*   **Cross-Origin Resource Sharing (CORS) Configuration:**
    ```json
    [
      {
        "AllowedHeaders": [
          "*"
        ],
        "AllowedMethods": [
          "PUT",
          "GET",
          "POST",
          "DELETE"
        ],
        "AllowedOrigins": [
          "*"
        ],
        "ExposeHeaders": []
      }
    ]
    ```

---

## 4. AWS Cognito User Pool
*   **User Pool ID:** `eu-west-2_ft1OVuuU1`
*   **App Client ID:** `2i0abels4ntovsi3o4u5b0ni41`
*   **App Client Name:** `caucsim-web-app`
*   **App Client Type:** Single Page Application (Public Client, *Client secret disabled*)
*   **Enabled Authentication Flows:** `ALLOW_USER_PASSWORD_AUTH`